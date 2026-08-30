//! Black-box integration tests: drive the compiled binary through the exact
//! protocol the TypeScript wrapper speaks (spec 019 T029). Every refusal
//! code in the closed set is exercised except `primitive-unsupported`
//! (unreachable on supported platforms by construction) and `timeout`
//! (watchdog construction; not deterministically testable without a 10 s
//! sleep). `parent-replaced` needs a racing swap, so its deterministic proxy
//! (the directory-identity check) is unit-tested inside the crate and the
//! no-false-positive case is covered here.

use std::io::Write;
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_seepient-fs-commit");

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "fs-commit-test-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // Canonicalize like the production analyzer does: /var → /private/var
        // on macOS is a symlink the helper correctly refuses.
        let dir = std::fs::canonicalize(dir).unwrap();
        TempDir(dir)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct CommitResult {
    ok: bool,
    written_sha256: String,
    error_code: Option<String>,
    message: Option<String>,
}

fn run(dest: &std::path::Path, content: &[u8], expected: Option<&str>) -> CommitResult {
    let mut args = vec!["--commit".to_string(), dest.to_string_lossy().to_string()];
    if let Some(e) = expected {
        args.push("--expected-sha256".to_string());
        args.push(e.to_string());
    }
    let mut child = Command::new(BIN)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn helper");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(content)
        .expect("write stdin");
    let output = child.wait_with_output().expect("wait");
    assert_eq!(output.status.code(), Some(0), "protocol: exit 0 with JSON");
    let v: serde_json::Value = serde_json::from_str(std::str::from_utf8(&output.stdout).unwrap().trim())
        .expect("valid single-line JSON on stdout");
    CommitResult {
        ok: v["ok"].as_bool().unwrap(),
        written_sha256: v["writtenSha256"].as_str().unwrap_or("").to_string(),
        error_code: v["errorCode"].as_str().map(|s| s.to_string()),
        message: v["message"].as_str().map(|s| s.to_string()),
    }
}

/// Digest of `bytes` computed by the helper itself: commit the bytes to a
/// scratch file and read the reported `writtenSha256` (round-trip trusted
/// against the known-answer vectors in the crate's sha256 unit tests).
fn helper_sha256(bytes: &[u8]) -> String {
    let dir = TempDir::new("hash-probe");
    let dest = dir.path().join("probe");
    let r = run(&dest, bytes, None);
    assert!(r.ok, "hash probe must succeed");
    r.written_sha256
}

#[test]
fn success_writes_content_and_reports_digest() {
    let dir = TempDir::new("success");
    let dest = dir.path().join("out.txt");
    let content = b"hello exact commit\n";
    let r = run(&dest, content, None);
    assert!(r.ok, "expected success, got {:?}", r.message);
    assert_eq!(r.written_sha256, helper_sha256(content));
    assert_eq!(std::fs::read(&dest).unwrap(), content);
    // The private temp (0600) becomes the file mode after rename.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // No temp files left behind.
    let leftovers: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".seepient-fs-commit.tmp."))
        .collect();
    assert!(leftovers.is_empty(), "temp leftovers: {:?}", leftovers);
}

#[test]
fn target_symlink_refuses_and_leaves_disk_untouched() {
    let dir = TempDir::new("target-symlink");
    let victim = dir.path().join("victim.txt");
    std::fs::write(&victim, b"original").unwrap();
    let link = dir.path().join("link.txt");
    std::os::unix::fs::symlink(&victim, &link).unwrap();

    let r = run(&link, b"malicious", None);
    assert!(!r.ok);
    assert_eq!(r.error_code.as_deref(), Some("target-symlink"));
    assert_eq!(std::fs::read(&victim).unwrap(), b"original");
}

#[test]
fn parent_symlink_refuses_resolution() {
    let dir = TempDir::new("parent-symlink");
    let real = dir.path().join("real");
    std::fs::create_dir_all(&real).unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let dest = link.join("out.txt");
    let r = run(&dest, b"data", None);
    assert!(!r.ok);
    assert_eq!(r.error_code.as_deref(), Some("parent-symlink"));
    assert_eq!(std::fs::read_dir(&real).unwrap().count(), 0);
}

#[test]
fn snapshot_changed_refuses_on_hash_mismatch() {
    let dir = TempDir::new("snapshot-changed");
    let dest = dir.path().join("f.txt");
    std::fs::write(&dest, b"current content").unwrap();

    let wrong = helper_sha256(b"snapshot-time content");
    let r = run(&dest, b"new content", Some(&wrong));
    assert!(!r.ok);
    assert_eq!(r.error_code.as_deref(), Some("snapshot-changed"));
    assert_eq!(std::fs::read(&dest).unwrap(), b"current content");
}

#[test]
fn matching_expected_snapshot_commits() {
    let dir = TempDir::new("matching-expected");
    let dest = dir.path().join("f.txt");
    std::fs::write(&dest, b"current content").unwrap();

    let correct = helper_sha256(b"current content");
    let r = run(&dest, b"new content", Some(&correct));
    assert!(r.ok, "expected success, got {:?}", r.message);
    assert_eq!(std::fs::read(&dest).unwrap(), b"new content");
}

#[test]
fn absent_file_with_expected_hash_refuses() {
    let dir = TempDir::new("absent-expected");
    let dest = dir.path().join("missing.txt");
    let expected = helper_sha256(b"content that was never there");
    let r = run(&dest, b"data", Some(&expected));
    assert!(!r.ok);
    assert_eq!(r.error_code.as_deref(), Some("snapshot-changed"));
}

#[test]
fn missing_parent_is_io_error() {
    let dir = TempDir::new("missing-parent");
    let dest = dir.path().join("no-such-dir").join("f.txt");
    let r = run(&dest, b"data", None);
    assert!(!r.ok);
    assert_eq!(r.error_code.as_deref(), Some("io-error"));
}

#[test]
fn stable_parent_does_not_trip_parent_replaced() {
    // No false positive from the (dev, ino) identity check on a stable dir.
    let dir = TempDir::new("parent-stable");
    let dest = dir.path().join("f.txt");
    let r = run(&dest, b"data", None);
    assert!(r.ok, "stable parent must not trip parent-replaced");
}

#[test]
fn binary_content_round_trips() {
    let dir = TempDir::new("binary");
    let dest = dir.path().join("blob.bin");
    let content: Vec<u8> = (0..=255u8).cycle().take(100_000).collect();
    let r = run(&dest, &content, None);
    assert!(r.ok);
    assert_eq!(std::fs::read(&dest).unwrap(), content);
}

#[test]
fn relative_destination_is_io_error() {
    let mut child = Command::new(BIN)
        .args(["--commit", "rel.txt"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"data").unwrap();
    let out = child.wait_with_output().unwrap();
    let v: serde_json::Value =
        serde_json::from_str(std::str::from_utf8(&out.stdout).unwrap().trim()).unwrap();
    assert!(!v["ok"].as_bool().unwrap());
    assert_eq!(v["errorCode"].as_str(), Some("io-error"));
}

#[test]
fn empty_expected_hash_is_ignored_wrapper_contract() {
    // The TS wrapper sends --expected-sha256 "" when its snapshot has no
    // hash; the helper must treat that as "no pre-check", not an error.
    let dir = TempDir::new("empty-expected");
    let dest = dir.path().join("f.txt");
    let r = run(&dest, b"data", Some(""));
    assert!(r.ok, "empty --expected-sha256 must be ignored, got {:?}", r.message);
    assert_eq!(std::fs::read(&dest).unwrap(), b"data");
}
