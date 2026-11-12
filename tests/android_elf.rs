//! ELF evidence for the R7 Android shared objects.
//!
//! The shared objects are build output, so this test only asserts anything when
//! `verify.mjs` has produced them on this host. Without the NDK (or before the
//! build ran) the test skips cleanly instead of failing.

use std::fs;
use std::path::{Path, PathBuf};

/// ELF identification bytes: `\x7fELF`.
const ELF_MAGIC: [u8; 4] = [0x7f, 0x45, 0x4c, 0x46];

/// ELF header field offsets: `e_machine` is a 16-bit value at byte 18.
const E_MACHINE_OFFSET: usize = 18;

const EM_AARCH64: u16 = 183;
const EM_X86_64: u16 = 62;

/// The build output directory, resolved from this crate's manifest directory.
fn target_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("target")
}

fn jni_libs_dir() -> PathBuf {
    target_dir().join("android").join("jniLibs")
}

/// Reads the ELF header of `path` and returns its machine type.
fn machine_of(path: &Path) -> Option<u16> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() < 20 || bytes[0..4] != ELF_MAGIC {
        return None;
    }
    Some(u16::from_le_bytes([
        bytes[E_MACHINE_OFFSET],
        bytes[E_MACHINE_OFFSET + 1],
    ]))
}

fn assert_elf(path: &Path, expected: u16) {
    let bytes = fs::read(path).expect("shared object is readable");
    assert_eq!(
        &bytes[0..4],
        &ELF_MAGIC,
        "{} does not start with the ELF magic bytes",
        path.display()
    );
    let machine = machine_of(path).expect("ELF header is complete");
    assert_eq!(
        machine,
        expected,
        "{} has machine type {}, expected {}",
        path.display(),
        machine,
        expected
    );
}

#[test]
fn android_shared_objects_are_valid_elf_for_their_abi() {
    let root = jni_libs_dir();
    if !root.exists() {
        eprintln!(
            "SKIP: {} does not exist; run `node verify.mjs` with an Android NDK first.",
            root.display()
        );
        return;
    }

    // The directory names are the Android ABI names used by a jniLibs folder.
    let cases = [("arm64-v8a", EM_AARCH64), ("x86_64", EM_X86_64)];
    for (abi, expected) in cases {
        let path = root.join(abi).join("libopurom_mobile.so");
        if !path.exists() {
            eprintln!(
                "SKIP: {} does not exist; run `node verify.mjs` with an Android NDK first.",
                path.display()
            );
            continue;
        }
        assert_elf(&path, expected);
    }
}
