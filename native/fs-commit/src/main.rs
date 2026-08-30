//! seepient-fs-commit — native exact-commit helper (spec 008/019).
//!
//! Owns the complete validate → write → revalidate → rename sequence for ONE
//! file commit. See README.md for the protocol; the TypeScript wrapper
//! (`src/vendors/native-fs-commit/index.ts`) is the other half of this
//! interface.

mod sha256;

use std::io::{Read, Write};
use std::process::exit;
use std::sync::mpsc;
use std::time::{Duration, Instant};

mod commit;
use commit::CommitOutcome;

/// Result envelope printed to stdout as ONE line (contract: closed codes).
struct CommitResult {
    ok: bool,
    written_sha256: String,
    error_code: Option<&'static str>,
    message: Option<String>,
}

fn print_result(result: &CommitResult) {
    let code = result
        .error_code
        .map(|c| format!("\"{}\"", c))
        .unwrap_or_else(|| "null".to_string());
    let message = match &result.message {
        Some(m) => {
            // Single-line JSON: strip control characters from messages.
            let sanitized: String = m
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect();
            let escaped = sanitized.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{}\"", escaped)
        }
        None => "null".to_string(),
    };
    println!(
        "{{\"ok\":{},\"writtenSha256\":\"{}\",\"errorCode\":{},\"message\":{}}}",
        result.ok, result.written_sha256, code, message
    );
    let _ = std::io::stdout().flush();
}

const TIMEOUT: Duration = Duration::from_secs(10);

/// Watchdog: if the main flow does not finish within the budget, report
/// `timeout` and exit. Best-effort by design — the helper never writes
/// anything before the final rename except its own private temp, which a
/// timeout abort may leave for the next run's O_EXCL name space (harmless).
fn start_watchdog() -> mpsc::Sender<()> {
    let (done_tx, done_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        if done_rx.recv_timeout(TIMEOUT).is_err() {
            print_result(&CommitResult {
                ok: false,
                written_sha256: String::new(),
                error_code: Some("timeout"),
                message: Some("helper exceeded its 10 s self-limit".to_string()),
            });
            exit(0);
        }
    });
    done_tx
}

fn fail(code: &'static str, message: impl Into<String>) -> CommitResult {
    CommitResult {
        ok: false,
        written_sha256: String::new(),
        error_code: Some(code),
        message: Some(message.into()),
    }
}

fn main() {
    let started = Instant::now();
    let done = start_watchdog();

    // 1. Argument parsing — exactly the contract surface, no env, no shell.
    let mut destination: Option<String> = None;
    let mut expected_sha256: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--commit" => {
                destination = args.next();
                if destination.is_none() {
                    let r = fail("io-error", "--commit requires a destination argument");
                    print_result(&r);
                    done.send(()).ok();
                    return;
                }
            }
            "--expected-sha256" => expected_sha256 = args.next(),
            other => {
                let r = fail("io-error", format!("unknown argument: {}", other));
                print_result(&r);
                done.send(()).ok();
                return;
            }
        }
    }
    let destination = match destination {
        Some(d) => d,
        None => {
            let r = fail("io-error", "missing --commit <destination>");
            print_result(&r);
            done.send(()).ok();
            return;
        }
    };
    // The wrapper sends an empty --expected-sha256 when its snapshot carries
    // no hash — treat that as "no pre-check". Any other non-64-hex value is
    // a protocol error.
    let expected_sha256 = match expected_sha256 {
        None => None,
        Some(s) if s.is_empty() => None,
        Some(s) if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) => Some(s.to_lowercase()),
        Some(other) => {
            let r = fail("io-error", format!("invalid --expected-sha256: {}", other));
            print_result(&r);
            done.send(()).ok();
            return;
        }
    };

    // 2. Read content from stdin (raw bytes, binary-safe).
    let mut content = Vec::new();
    if std::io::stdin().read_to_end(&mut content).is_err() {
        let r = fail("io-error", "failed to read content from stdin");
        print_result(&r);
        done.send(()).ok();
        return;
    }

    if started.elapsed() > TIMEOUT {
        let r = fail("timeout", "helper exceeded its 10 s self-limit");
        print_result(&r);
        done.send(()).ok();
        return;
    }

    // 3. The owned commit sequence.
    let result = match commit::commit_file(&destination, &content, expected_sha256.as_deref()) {
        CommitOutcome::Committed(sha) => CommitResult {
            ok: true,
            written_sha256: sha,
            error_code: None,
            message: None,
        },
        CommitOutcome::Refused { code, message } => CommitResult {
            ok: false,
            written_sha256: String::new(),
            error_code: Some(code),
            message: Some(message),
        },
    };
    print_result(&result);
    done.send(()).ok();
}

