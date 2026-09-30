//! Contracts of the shared tree removal on real temporary directories: what
//! survives, what is refused, and which bounds hold.
use super::*;
use std::{
    fs,
    os::unix::{ffi::OsStrExt, fs::symlink},
    path::{Path, PathBuf},
};

const STRICT: Policy = Policy {
    max_depth: 64,
    mount_evidence: MountEvidence::DeviceFallback,
    absent_root: AbsentRoot::Refused,
};

fn temp() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(directory.path()).unwrap();
    (directory, base)
}

type AdmitHook<'a> = Box<dyn FnMut(&Entry<'_>) -> io::Result<()> + 'a>;
type UnlinkHook<'a> = Box<dyn FnMut(&OsStr, bool) -> io::Result<()> + 'a>;
type EmptiedHook<'a> = Box<dyn FnMut() -> io::Result<()> + 'a>;

/// Real effects, with a caller seam at each point the walk hands control out.
struct Probe<'a> {
    admit: AdmitHook<'a>,
    before_unlink: UnlinkHook<'a>,
    emptied: EmptiedHook<'a>,
    admitted: Vec<(PathBuf, usize)>,
}

fn probe<'a>() -> Probe<'a> {
    Probe {
        admit: Box::new(|_| Ok(())),
        before_unlink: Box::new(|_, _| Ok(())),
        emptied: Box::new(|| Ok(())),
        admitted: Vec::new(),
    }
}

impl<'a> Probe<'a> {
    fn on_admit(self, admit: impl FnMut(&Entry<'_>) -> io::Result<()> + 'a) -> Self {
        Self {
            admit: Box::new(admit),
            ..self
        }
    }

    fn on_unlink(self, hook: impl FnMut(&OsStr, bool) -> io::Result<()> + 'a) -> Self {
        Self {
            before_unlink: Box::new(hook),
            ..self
        }
    }

    fn on_emptied(self, hook: impl FnMut() -> io::Result<()> + 'a) -> Self {
        Self {
            emptied: Box::new(hook),
            ..self
        }
    }
}

impl Removal for Probe<'_> {
    type Error = io::Error;

    fn admit(&mut self, entry: &Entry<'_>) -> io::Result<()> {
        self.admitted.push((entry.relative.to_owned(), entry.depth));
        (self.admit)(entry)
    }

    fn unlink(
        &mut self,
        directory: &Directory,
        name: &OsStr,
        is_directory: bool,
    ) -> io::Result<()> {
        (self.before_unlink)(name, is_directory)?;
        directory.unlink(name, is_directory)
    }

    fn emptied(&mut self, _directory: &Directory) -> io::Result<()> {
        (self.emptied)()
    }
}

fn run<R: Removal<Error = io::Error>>(
    base: &Path,
    name: &str,
    policy: Policy,
    removal: &mut R,
) -> Result<(), Partial<io::Error>> {
    let container = Directory::open(base).unwrap();
    let mut unbounded = usize::MAX;
    remove(
        &container,
        OsStr::new(name),
        policy,
        &mut unbounded,
        removal,
    )
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

#[test]
fn a_tree_is_removed_without_following_links_or_touching_special_file_targets() {
    let (_guard, base) = temp();
    let outside = base.join("outside");
    fs::create_dir_all(outside.join("inner")).unwrap();
    fs::write(outside.join("inner/kept"), b"kept").unwrap();
    let tree = base.join("tree");
    fs::create_dir_all(tree.join("a/b")).unwrap();
    fs::write(tree.join("a/b/leaf"), b"leaf").unwrap();
    fs::write(tree.join("top"), b"top").unwrap();
    symlink(&outside, tree.join("a/to-directory")).unwrap();
    symlink(outside.join("inner/kept"), tree.join("to-file")).unwrap();
    symlink(base.join("missing"), tree.join("dangling")).unwrap();
    let fifo = std::ffi::CString::new(tree.join("a/fifo").as_os_str().as_bytes()).unwrap();
    // SAFETY: the path is a valid terminated string for this call.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    std::os::unix::net::UnixListener::bind(tree.join("socket")).unwrap();

    run(&base, "tree", STRICT, &mut probe()).unwrap_or_else(|p| panic!("{}", p.error));

    assert!(!exists(&tree));
    assert_eq!(fs::read(outside.join("inner/kept")).unwrap(), b"kept");
}

#[test]
fn a_root_link_to_a_directory_is_unlinked_not_entered() {
    let (_guard, base) = temp();
    fs::create_dir(base.join("target")).unwrap();
    fs::write(base.join("target/kept"), b"kept").unwrap();
    symlink(base.join("target"), base.join("link")).unwrap();

    run(&base, "link", STRICT, &mut probe()).unwrap_or_else(|p| panic!("{}", p.error));

    assert!(!exists(&base.join("link")));
    assert_eq!(fs::read(base.join("target/kept")).unwrap(), b"kept");
}

#[test]
fn every_entry_is_admitted_with_its_path_and_depth_before_any_effect() {
    let (_guard, base) = temp();
    fs::create_dir_all(base.join("tree/sub")).unwrap();
    fs::write(base.join("tree/sub/leaf"), b"x").unwrap();
    let mut removal = probe();

    run(&base, "tree", STRICT, &mut removal).unwrap_or_else(|p| panic!("{}", p.error));

    let first: Vec<_> = removal
        .admitted
        .iter()
        .map(|(path, depth)| (path.to_str().unwrap(), *depth))
        .collect();
    // Entry, then each emptied directory again right before its own unlink.
    assert_eq!(
        first,
        [
            ("tree", 1),
            ("tree/sub", 2),
            ("tree/sub/leaf", 3),
            ("tree/sub", 2),
            ("tree", 1),
        ]
    );
}

#[test]
fn a_refused_entry_stops_the_walk_and_survives() {
    let (_guard, base) = temp();
    fs::create_dir_all(base.join("tree/private")).unwrap();
    fs::write(base.join("tree/private/secret"), b"secret").unwrap();
    let mut removal = probe().on_admit(|entry| {
        if entry.relative == Path::new("tree/private/secret") {
            Err(io::Error::other("not authorized"))
        } else {
            Ok(())
        }
    });

    let partial = run(&base, "tree", STRICT, &mut removal).unwrap_err();

    assert_eq!(partial.error.to_string(), "not authorized");
    assert!(!partial.removed);
    assert_eq!(
        fs::read(base.join("tree/private/secret")).unwrap(),
        b"secret"
    );
}

#[test]
fn the_depth_limit_admits_exactly_its_depth_and_refuses_one_more() {
    let (_guard, base) = temp();
    // tree=1, a=2, b=3, leaf=4.
    fs::create_dir_all(base.join("tree/a/b")).unwrap();
    fs::write(base.join("tree/a/b/leaf"), b"deep").unwrap();
    let limited = |max_depth| Policy {
        max_depth,
        ..STRICT
    };

    let partial = run(&base, "tree", limited(3), &mut probe()).unwrap_err();
    assert_eq!(partial.error.kind(), io::ErrorKind::InvalidData);
    assert!(
        partial.error.to_string().contains("depth"),
        "{}",
        partial.error
    );
    assert!(!partial.removed);
    assert_eq!(fs::read(base.join("tree/a/b/leaf")).unwrap(), b"deep");

    run(&base, "tree", limited(4), &mut probe()).unwrap_or_else(|p| panic!("{}", p.error));
    assert!(!exists(&base.join("tree")));
}

#[test]
fn one_entry_budget_bounds_several_roots() {
    let (_guard, base) = temp();
    for root in ["one", "two"] {
        fs::create_dir(base.join(root)).unwrap();
        fs::write(base.join(root).join("leaf"), b"x").unwrap();
    }
    let container = Directory::open(&base).unwrap();
    // Two entries per root: the root and its leaf.
    let mut budget = 3;
    remove(
        &container,
        OsStr::new("one"),
        STRICT,
        &mut budget,
        &mut probe(),
    )
    .unwrap_or_else(|p| panic!("{}", p.error));
    assert_eq!(budget, 1);
    let partial = remove(
        &container,
        OsStr::new("two"),
        STRICT,
        &mut budget,
        &mut probe(),
    )
    .unwrap_err();
    assert!(
        partial.error.to_string().contains("entry limit"),
        "{}",
        partial.error
    );
    assert_eq!(fs::read(base.join("two/leaf")).unwrap(), b"x");
}

#[test]
fn an_absent_root_is_complete_only_for_resumable_removal() {
    let (_guard, base) = temp();
    let resumable = Policy {
        absent_root: AbsentRoot::Removed,
        ..STRICT
    };
    run(&base, "gone", resumable, &mut probe()).unwrap_or_else(|p| panic!("{}", p.error));
    let partial = run(&base, "gone", STRICT, &mut probe()).unwrap_err();
    assert_eq!(partial.error.kind(), io::ErrorKind::NotFound);
    assert!(!partial.removed);
}

#[test]
fn a_failure_reports_whether_anything_was_already_unlinked() {
    for (fail_at, removed) in [(1, false), (2, true)] {
        let (_guard, base) = temp();
        fs::create_dir(base.join("tree")).unwrap();
        for name in ["a", "b", "c"] {
            fs::write(base.join("tree").join(name), name).unwrap();
        }
        let mut count = 0;
        let mut removal = probe().on_unlink(|_, _| {
            count += 1;
            if count == fail_at {
                Err(io::Error::other("injected"))
            } else {
                Ok(())
            }
        });
        let partial = run(&base, "tree", STRICT, &mut removal).unwrap_err();
        assert_eq!(partial.removed, removed, "failing unlink {fail_at}");
        assert_eq!(
            fs::read_dir(base.join("tree")).unwrap().count(),
            3 - (fail_at - 1)
        );
    }
}

#[test]
fn a_directory_swapped_after_admission_is_never_entered() {
    for substitute_is_link in [false, true] {
        let (_guard, base) = temp();
        fs::create_dir_all(base.join("tree/sub")).unwrap();
        fs::write(base.join("tree/sub/admitted"), b"admitted").unwrap();
        fs::create_dir(base.join("victim")).unwrap();
        fs::write(base.join("victim/bytes"), b"victim").unwrap();
        let swap_base = base.clone();
        let mut removal = probe().on_admit(move |entry| {
            if entry.relative == Path::new("tree/sub") && entry.depth == 2 {
                fs::rename(swap_base.join("tree/sub"), swap_base.join("admitted-sub"))?;
                if substitute_is_link {
                    symlink(swap_base.join("victim"), swap_base.join("tree/sub"))?;
                } else {
                    fs::rename(swap_base.join("victim"), swap_base.join("tree/sub"))?;
                }
            }
            Ok(())
        });

        let partial = run(&base, "tree", STRICT, &mut removal).unwrap_err();

        assert!(!partial.removed, "{}", partial.error);
        let victim = if substitute_is_link {
            base.join("victim/bytes")
        } else {
            base.join("tree/sub/bytes")
        };
        assert_eq!(fs::read(victim).unwrap(), b"victim");
        assert_eq!(
            fs::read(base.join("admitted-sub/admitted")).unwrap(),
            b"admitted"
        );
    }
}

#[test]
fn a_directory_moved_out_of_the_tree_mid_walk_never_redirects_its_ascent() {
    let (_guard, base) = temp();
    fs::create_dir_all(base.join("tree/sub")).unwrap();
    fs::write(base.join("tree/sub/first"), b"x").unwrap();
    fs::write(base.join("tree/sub/second"), b"x").unwrap();
    fs::create_dir(base.join("elsewhere")).unwrap();
    fs::write(base.join("elsewhere/unrelated"), b"unrelated").unwrap();
    let swap_base = base.clone();
    let mut moved = false;
    let mut removal = probe().on_unlink(move |_, directory| {
        if !moved && !directory {
            moved = true;
            fs::rename(swap_base.join("tree/sub"), swap_base.join("elsewhere/sub"))?;
        }
        Ok(())
    });

    let partial = run(&base, "tree", STRICT, &mut removal).unwrap_err();

    assert!(
        partial.error.to_string().contains("moved"),
        "{}",
        partial.error
    );
    // The admitted object may be emptied where it went, but its new parent's
    // other entries and the new parent itself are never touched.
    assert_eq!(
        fs::read(base.join("elsewhere/unrelated")).unwrap(),
        b"unrelated"
    );
    assert!(exists(&base.join("elsewhere/sub")));
    assert!(exists(&base.join("tree")));
}

#[test]
fn an_emptied_directory_replaced_before_its_unlink_is_kept() {
    let (_guard, base) = temp();
    fs::create_dir_all(base.join("tree/sub")).unwrap();
    fs::write(base.join("tree/sub/leaf"), b"x").unwrap();
    let swap_base = base.clone();
    let mut swapped = false;
    let mut removal = probe().on_emptied(move || {
        if !swapped {
            swapped = true;
            // Within the same parent, so the ascent still finds its parent.
            fs::rename(swap_base.join("tree/sub"), swap_base.join("tree/emptied"))?;
            // An empty stand-in: rmdir alone would have removed it.
            fs::create_dir(swap_base.join("tree/sub"))?;
        }
        Ok(())
    });

    let partial = run(&base, "tree", STRICT, &mut removal).unwrap_err();

    assert!(
        partial.error.to_string().contains("replaced"),
        "{}",
        partial.error
    );
    assert!(base.join("tree/sub").is_dir());
}

/// Mount-boundary decisions without a mount: a directory on another device, or
/// any entry on another known mount, is refused. A non-directory may report a
/// lower layer's device (overlayfs), so only its mount id counts.
#[test]
fn the_fence_refuses_other_devices_for_directories_and_other_mounts_for_all() {
    let fence = |evidence| Fence {
        mount: Mount {
            device: 1,
            id: Some(10),
        },
        evidence,
    };
    for evidence in [MountEvidence::Required, MountEvidence::DeviceFallback] {
        let fence = fence(evidence);
        let at = |device, id| Mount { device, id };
        assert!(fence.check(at(1, Some(10)), true).is_ok());
        assert!(fence.check(at(2, Some(10)), true).is_err());
        assert!(fence.check(at(2, Some(10)), false).is_ok());
        assert!(fence.check(at(1, Some(11)), true).is_err());
        assert!(fence.check(at(1, Some(11)), false).is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn missing_mount_identity_refuses_only_when_it_is_required() {
    let at = |id| Mount { device: 1, id };
    for (reference, observed) in [(Some(10), None), (None, Some(10)), (None, None)] {
        let fence = |evidence| Fence {
            mount: at(reference),
            evidence,
        };
        assert!(fence(MountEvidence::Required)
            .check(at(observed), true)
            .is_err());
        assert!(fence(MountEvidence::DeviceFallback)
            .check(at(observed), true)
            .is_ok());
    }
}

const DESCRIPTOR_ROOT: &str = "EXPLORER_TREE_REMOVAL_DESCRIPTOR_ROOT";

/// Deeper than PATH_MAX and wider than the descriptor limit the removal runs
/// under: any per-level or per-entry descriptor would exhaust it.
#[cfg(target_os = "linux")]
#[test]
fn deep_and_wide_trees_are_removed_under_a_small_descriptor_limit() {
    let (_guard, base) = temp();
    let tree = base.join("tree");
    fs::create_dir(&tree).unwrap();
    for index in 0..300 {
        let wide = tree.join(format!("wide-{index}"));
        fs::create_dir(&wide).unwrap();
        fs::write(wide.join("leaf"), b"x").unwrap();
    }
    let mut directory = Directory::open(&tree).unwrap();
    for _ in 0..3_000 {
        directory = directory.create_directory(OsStr::new("d")).unwrap();
    }
    for index in 0..300 {
        directory
            .create_file(OsStr::new(&format!("file-{index}")))
            .unwrap();
    }
    drop(directory);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "files::tree_removal::tests::subprocess_bounded_descriptors",
            "--ignored",
            "--nocapture",
        ])
        .env(DESCRIPTOR_ROOT, &base)
        .status()
        .unwrap();
    assert!(status.success(), "bounded removal failed: {status}");
    assert!(!exists(&tree));
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "spawned by deep_and_wide_trees_are_removed_under_a_small_descriptor_limit"]
fn subprocess_bounded_descriptors() {
    let base = PathBuf::from(std::env::var_os(DESCRIPTOR_ROOT).expect("parent fixture"));
    let open = fs::read_dir("/proc/self/fd").unwrap().count();
    let limit = (open + 8) as libc::rlim_t;
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit/setrlimit only read and write the given struct, and the
    // lowered soft limit affects this spawned child alone.
    unsafe {
        assert_eq!(libc::getrlimit(libc::RLIMIT_NOFILE, &mut current), 0);
        current.rlim_cur = limit;
        assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &current), 0);
    }
    let policy = Policy {
        max_depth: 4_000,
        ..STRICT
    };
    let container = Directory::open(&base).unwrap();
    let mut unbounded = usize::MAX;
    remove(
        &container,
        OsStr::new("tree"),
        policy,
        &mut unbounded,
        &mut probe(),
    )
    .unwrap_or_else(|p| panic!("removal under {limit} descriptors: {}", p.error));
}

/// A bind mount of the same filesystem keeps its device; only mount identity
/// reveals it. Neither policy may enter it or unlink anything it exposes.
#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn a_bind_mount_inside_the_tree_is_never_entered() {
    use crate::files::mount_namespace::{require_private_namespace, BindMount};
    require_private_namespace();
    for evidence in [MountEvidence::Required, MountEvidence::DeviceFallback] {
        for mounted_leaf in [false, true] {
            let (_guard, base) = temp();
            let tree = base.join("tree");
            fs::create_dir(&tree).unwrap();
            fs::write(base.join("foreign-file"), b"foreign").unwrap();
            fs::create_dir(base.join("foreign-directory")).unwrap();
            fs::write(base.join("foreign-directory/bytes"), b"foreign").unwrap();
            let (source, point) = if mounted_leaf {
                fs::write(tree.join("mounted"), b"covered").unwrap();
                (base.join("foreign-file"), tree.join("mounted"))
            } else {
                fs::create_dir(tree.join("mounted")).unwrap();
                (base.join("foreign-directory"), tree.join("mounted"))
            };
            let _mount = BindMount::new(&source, &point);
            let policy = Policy {
                mount_evidence: evidence,
                ..STRICT
            };

            let partial = run(&base, "tree", policy, &mut probe()).unwrap_err();

            assert!(
                partial.error.to_string().contains("mount"),
                "{evidence:?} leaf={mounted_leaf}: {}",
                partial.error
            );
            assert_eq!(fs::read(base.join("foreign-file")).unwrap(), b"foreign");
            assert_eq!(
                fs::read(base.join("foreign-directory/bytes")).unwrap(),
                b"foreign"
            );
            assert!(exists(&point));
        }
    }
}
