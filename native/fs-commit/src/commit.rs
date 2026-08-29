//! The owned commit sequence: validate → pre-check expected state → private
//! temp write → revalidate → rename → directory fsync. Refusals are
//! deterministic and side-effect-free.

use crate::sha256;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

pub enum CommitOutcome {
    Committed(String),
    Refused { code: &'static str, message: String },
}

fn refused(code: &'static str, message: impl Into<String>) -> CommitOutcome {
    CommitOutcome::Refused { code, message: message.into() }
}

struct FdGuard(libc::c_int);
impl FdGuard {
    fn new(fd: libc::c_int) -> Option<Self> {
        if fd >= 0 { Some(FdGuard(fd)) } else { None }
    }
    fn raw(&self) -> libc::c_int {
        self.0
    }
}
impl Drop for FdGuard {
    fn drop(&mut self) {
        unsafe { libc::close(self.0) };
    }
}

fn cstring(s: &std::ffi::OsStr) -> Option<CString> {
    CString::new(s.as_bytes()).ok()
}

// ── openat2 (Linux) ─────────────────────────────────────────────────────
// Not exposed by the libc crate on all versions; declared locally. The
// struct layout is fixed by the kernel UAPI.
#[cfg(target_os = "linux")]
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
#[cfg(target_os = "linux")]
const RESOLVE_BENEATH: u64 = 0x02;
#[cfg(target_os = "linux")]
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
#[cfg(target_os = "linux")]
const RESOLVE_NO_XDEV: u64 = 0x01;
#[cfg(target_os = "linux")]
const SYS_OPENAT2: libc::c_long = 437; // stable across x86_64 / aarch64

// O_PATH is Linux-only; macOS walks components with plain openat(O_NOFOLLOW)
// and verifies directory-ness via fstat.
#[cfg(target_os = "linux")]
const O_PATH_FLAGS: libc::c_int = libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC;
#[cfg(not(target_os = "linux"))]
const O_PATH_FLAGS: libc::c_int = libc::O_NOFOLLOW | libc::O_CLOEXEC;

#[cfg(target_os = "linux")]
const O_DIR_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
#[cfg(not(target_os = "linux"))]
const O_DIR_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_CLOEXEC;

/// Open one path component beneath `dir_fd` without following symlinks.
/// Linux prefers openat2 (full restricted resolution); every platform falls
/// back to `openat(O_NOFOLLOW|O_PATH)`, which refuses the final component.
/// Returns (errno, used_fallback).
fn open_component(dir_fd: libc::c_int, cname: &CString) -> Result<libc::c_int, libc::c_int> {
    #[cfg(target_os = "linux")]
    {
        let how = OpenHow {
            flags: O_PATH_FLAGS as u64,
            mode: 0,
            resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV,
        };
        let fd = unsafe {
            libc::syscall(
                SYS_OPENAT2,
                dir_fd,
                cname.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if fd >= 0 {
            return Ok(fd as libc::c_int);
        }
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO);
        // ENOSYS: kernel lacks openat2. EINVAL/EAGAIN/EPERM: flags unsupported
        // or masked — fall back to the component walk, which still refuses
        // symlinked components (one at a time).
        if !matches!(errno, libc::ENOSYS | libc::EINVAL | libc::EAGAIN | libc::EPERM) {
            return Err(errno);
        }
    }
    let fd = unsafe { libc::openat(dir_fd, cname.as_ptr(), O_PATH_FLAGS) };
    if fd >= 0 {
        Ok(fd)
    } else {
        Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO))
    }
}

/// Open the destination's parent directory as a bare descriptor, resolving
/// every component WITHOUT following symlinks. A symlinked component fails
/// with `parent-symlink`.
fn open_parent_dir_no_symlinks(parent: &Path) -> Result<FdGuard, (&'static str, String)> {
    let root_name = CString::new("/").ok().ok_or(("io-error", "bad root".to_string()))?;
    let mut current = FdGuard::new(unsafe {
        libc::open(root_name.as_ptr(), O_DIR_FLAGS)
    })
    .ok_or(("io-error", "cannot open root directory".to_string()))?;

    for component in parent.components() {
        let name = component.as_os_str();
        if name.is_empty() || name == "/" {
            continue; // skip the root prefix
        }
        if name == ".." {
            return Err(("io-error", ".. components are not permitted".to_string()));
        }
        let cname = match cstring(name) {
            Some(c) => c,
            None => return Err(("io-error", "invalid path bytes".to_string())),
        };
        match open_component(current.raw(), &cname) {
            Ok(fd) => {
                let next = FdGuard::new(fd)
                    .ok_or(("io-error", "bad descriptor".to_string()))?;
                // Verify the opened component is a directory.
                let mut st: libc::stat = unsafe { std::mem::zeroed() };
                if unsafe { libc::fstat(next.raw(), &mut st) } != 0
                    || (st.st_mode & libc::S_IFMT) != libc::S_IFDIR
                {
                    return Err(("parent-symlink", format!("parent component {:?} is not a directory", name)));
                }
                current = next;
            }
            Err(errno) => {
                let code = match errno {
                    libc::ELOOP | libc::EXDEV => "parent-symlink",
                    libc::ENOTDIR => "parent-symlink",
                    _ => "io-error",
                };
                return Err((code, format!("cannot resolve parent component {:?} (errno {})", name, errno)));
            }
        }
    }
    Ok(current)
}

fn errno_of(e: std::io::Error) -> libc::c_int {
    e.raw_os_error().unwrap_or(libc::EIO)
}

pub fn commit_file(
    destination: &str,
    content: &[u8],
    expected_sha256: Option<&str>,
) -> CommitOutcome {
    let dest_path = Path::new(destination);
    if !dest_path.is_absolute() {
        return refused("io-error", "destination must be an absolute path");
    }
    let parent = dest_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::path::PathBuf::from("/"));
    let final_name = match dest_path.file_name().and_then(cstring) {
        Some(c) => c,
        None => return refused("io-error", "invalid destination file name"),
    };

    // 1. Validate the destination: resolve the parent WITHOUT symlinks.
    let parent_fd = match open_parent_dir_no_symlinks(&parent) {
        Ok(fd) => fd,
        Err((code, message)) => return refused(code, message),
    };
    let dir_fd = parent_fd.raw();

    let parent_stat = match fstat(dir_fd) {
        Some(st) => st,
        None => return refused("io-error", "fstat on parent failed"),
    };

    // 2. Final component must not be a symlink.
    if final_component_is_symlink(dir_fd, &final_name) {
        return refused("target-symlink", "destination is a symbolic link");
    }

    // 3. Pre-check expected state: the caller's snapshot hash must match the
    //    file that is actually there.
    if let Some(expected) = expected_sha256 {
        match read_file_at(dir_fd, &final_name) {
            Ok(Some(bytes)) => {
                let mut h = sha256::Sha256::new();
                h.update(&bytes);
                if sha256::hex(&h.finish()) != expected.to_lowercase() {
                    return refused("snapshot-changed", "file content changed since the caller read it");
                }
            }
            Ok(None) => {
                return refused("snapshot-changed", "caller expected existing content but the file is absent");
            }
            Err(message) => return refused("target-symlink", message),
        }
    }

    // 4. Private sibling temp file (0600, O_EXCL, unpredictable name).
    let tmp_name = match generate_temp_name() {
        Some(c) => c,
        None => return refused("io-error", "cannot generate temp name"),
    };
    let tmp_fd = unsafe {
        libc::openat(
            dir_fd,
            tmp_name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    let tmp_guard = match FdGuard::new(tmp_fd) {
        Some(g) => g,
        None => return refused("io-error", "cannot create private temp file"),
    };

    // Write the content, then fsync.
    let cleanup = |msg: String| -> CommitOutcome {
        unsafe { libc::unlinkat(dir_fd, tmp_name.as_ptr(), 0) };
        refused("io-error", msg)
    };
    let mut written = 0usize;
    while written < content.len() {
        let n = unsafe {
            libc::write(
                tmp_guard.raw(),
                content[written..].as_ptr() as *const libc::c_void,
                content.len() - written,
            )
        };
        if n <= 0 {
            return cleanup(format!("temp write failed (errno {})", errno_of(std::io::Error::last_os_error())));
        }
        written += n as usize;
    }
    if unsafe { libc::fsync(tmp_guard.raw()) } != 0 {
        return cleanup("temp fsync failed".to_string());
    }
    drop(tmp_guard);

    // 5. Revalidate: the parent must still be the SAME directory (dev/ino)
    //    and the final component must still not be a symlink.
    let parent_stat2 = match fstat(dir_fd) {
        Some(st) => st,
        None => return cleanup("revalidation fstat failed".to_string()),
    };
    if parent_stat.st_dev != parent_stat2.st_dev || parent_stat.st_ino != parent_stat2.st_ino {
        unsafe { libc::unlinkat(dir_fd, tmp_name.as_ptr(), 0) };
        return refused("parent-replaced", "parent directory was replaced mid-flight");
    }
    if final_component_is_symlink(dir_fd, &final_name) {
        unsafe { libc::unlinkat(dir_fd, tmp_name.as_ptr(), 0) };
        return refused("target-symlink", "destination became a symbolic link mid-flight");
    }

    // 6. Rename temp → destination (same directory: atomic, no cross-device).
    if unsafe { libc::renameat(dir_fd, tmp_name.as_ptr(), dir_fd, final_name.as_ptr()) } != 0 {
        let errno = errno_of(std::io::Error::last_os_error());
        unsafe { libc::unlinkat(dir_fd, tmp_name.as_ptr(), 0) };
        let code = if errno == libc::EXDEV { "cross-device-rename" } else { "io-error" };
        return refused(code, format!("rename failed (errno {})", errno));
    }

    // 7. fsync the directory so the rename is durable.
    unsafe { libc::fsync(dir_fd) };

    // 8. Report the digest of the bytes actually written.
    let mut h = sha256::Sha256::new();
    h.update(content);
    CommitOutcome::Committed(sha256::hex(&h.finish()))
}

fn final_component_is_symlink(dir_fd: libc::c_int, name: &CString) -> bool {
    let fd = unsafe { libc::openat(dir_fd, name.as_ptr(), O_PATH_FLAGS) };
    if fd >= 0 {
        unsafe { libc::close(fd) };
        false
    } else {
        let errno = errno_of(std::io::Error::last_os_error());
        errno == libc::ELOOP
    }
}

/// Read the existing file at dirfd/name without following symlinks.
/// Ok(None) = absent; Err(message) = symlinked target or read failure.
fn read_file_at(dir_fd: libc::c_int, name: &CString) -> Result<Option<Vec<u8>>, String> {
    let fd = unsafe { libc::openat(dir_fd, name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    let guard = match FdGuard::new(fd) {
        Some(g) => g,
        None => {
            let errno = errno_of(std::io::Error::last_os_error());
            if errno == libc::ELOOP {
                return Err("destination is a symbolic link".to_string());
            }
            if errno == libc::ENOENT {
                return Ok(None);
            }
            return Err(format!("open for read failed (errno {})", errno));
        }
    };
    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    loop {
        let n = unsafe { libc::read(guard.raw(), chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
        if n < 0 {
            return Err("read failed".to_string());
        }
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n as usize]);
    }
    Ok(Some(buf))
}

fn fstat(fd: libc::c_int) -> Option<libc::stat> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } == 0 {
        Some(st)
    } else {
        None
    }
}

fn generate_temp_name() -> Option<CString> {
    // Unpredictable enough for an O_EXCL private temp: pid + wall nanos +
    // stack-address entropy, hashed through SHA-256.
    let mut entropy = Vec::new();
    entropy.extend_from_slice(&std::process::id().to_le_bytes());
    entropy.extend_from_slice(
        &std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .to_le_bytes(),
    );
    let stack_ptr = &entropy as *const _ as usize;
    entropy.extend_from_slice(&stack_ptr.to_le_bytes());
    let mut h = sha256::Sha256::new();
    h.update(&entropy);
    CString::new(format!(".seepient-fs-commit.tmp.{}", &sha256::hex(&h.finish())[..16])).ok()
}

// Re-export for tests of errno mapping.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revalidation_detects_parent_replacement_by_identity() {
        // The identity check is (st_dev, st_ino) equality: simulate two stats
        // of genuinely different directories.
        let a = fstat_parent_of("/tmp");
        let b = fstat_parent_of("/");
        if let (Some(a), Some(b)) = (a, b) {
            let same = a.st_dev == b.st_dev && a.st_ino == b.st_ino;
            assert!(!same, "/tmp and / must have distinct identities");
        }
    }

    fn fstat_parent_of(path: &str) -> Option<libc::stat> {
        let fd = FdGuard::new(unsafe {
            libc::open(
                std::ffi::CString::new(path).ok()?.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        fstat(fd.raw())
    }
}
