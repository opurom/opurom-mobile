//! Dynamic-symbol evidence for the Android shared objects.
//!
//! `verify.mjs` checks exported JNI and C ABI symbols with the NDK's
//! `llvm-readelf`. This test reads the ELF64 section headers itself, so the same
//! evidence is available with pure standard-library Rust on a host without the
//! NDK tools. Synthetic ELF64 images exercise the reader on every host; the
//! built shared objects are checked when the verifier has produced them.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const ELF_MAGIC: [u8; 4] = [0x7f, 0x45, 0x4c, 0x46];
const ELFCLASS64: u8 = 2;
const ELFDATA2LSB: u8 = 1;
const ET_DYN: u16 = 3;
const SHT_NULL: u32 = 0;
const SHT_STRTAB: u32 = 3;
const SHT_NOBITS: u32 = 8;
const SHT_DYNSYM: u32 = 11;
const HEADER_SIZE: usize = 64;
const SECTION_HEADER_SIZE: usize = 64;
const SYMBOL_SIZE: usize = 24;

const EM_AARCH64: u16 = 183;
const EM_X86_64: u16 = 62;

/// The verifier asserts these names with the NDK readelf; the Rust reader uses
/// the same list so both checks agree on the required exported entry points.
const EXPECTED_EXPORTS: [&str; 16] = [
    "Java_org_opurom_mobile_OpuromNative_opuStateNew",
    "Java_org_opurom_mobile_OpuromNative_opuDispatch",
    "Java_org_opurom_mobile_OpuromNative_opuFrame",
    "Java_org_opurom_mobile_OpuromNative_opuStateFree",
    "Java_org_opurom_mobile_OpuromNative_opuRendererNew",
    "Java_org_opurom_mobile_OpuromNative_opuRendererFrame",
    "Java_org_opurom_mobile_OpuromNative_opuRendererFree",
    "Java_org_opurom_mobile_OpuromNative_opuFrameFromIr",
    "opu_state_new",
    "opu_dispatch",
    "opu_frame",
    "opu_state_free",
    "opu_frame_from_ir",
    "opu_renderer_new",
    "opu_renderer_frame",
    "opu_renderer_free",
];

#[derive(Debug)]
struct Elf64 {
    machine: u16,
    exports: BTreeSet<String>,
}

struct Section {
    kind: u32,
    offset: usize,
    size: usize,
    link: usize,
    ent_size: usize,
}

fn at(base: usize, delta: usize) -> Result<usize, &'static str> {
    base.checked_add(delta).ok_or("ELF offset overflow")
}

fn read<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], &'static str> {
    let slice = bytes
        .get(offset..at(offset, N)?)
        .ok_or("ELF image is truncated")?;
    Ok(slice.try_into().expect("a slice of N bytes is [u8; N]"))
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, &'static str> {
    Ok(u16::from_le_bytes(read(bytes, offset)?))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, &'static str> {
    Ok(u32::from_le_bytes(read(bytes, offset)?))
}

fn u64_at(bytes: &[u8], offset: usize) -> Result<u64, &'static str> {
    Ok(u64::from_le_bytes(read(bytes, offset)?))
}

fn usize_at(bytes: &[u8], offset: usize) -> Result<usize, &'static str> {
    usize::try_from(u64_at(bytes, offset)?).map_err(|_| "ELF offset does not fit the host")
}

fn put<const N: usize>(bytes: &mut [u8], offset: usize, value: [u8; N]) {
    bytes[offset..offset + N].copy_from_slice(&value);
}

/// Builds a minimal ELF64 shared object with one dynamic symbol table and its
/// linked string table, so the reader can be exercised without build output.
fn synthetic_elf(machine: u16, symbols: &[(&str, u8, bool)]) -> Vec<u8> {
    let mut strings = vec![0u8];
    let mut names = Vec::new();
    for (name, _, _) in symbols {
        names.push(strings.len());
        strings.extend_from_slice(name.as_bytes());
        strings.push(0);
    }
    let symbols_offset = HEADER_SIZE;
    let strings_offset = symbols_offset + symbols.len() * SYMBOL_SIZE;
    let sections_offset = strings_offset + strings.len();
    let mut bytes = vec![0u8; sections_offset + 3 * SECTION_HEADER_SIZE];

    bytes[0..4].copy_from_slice(&ELF_MAGIC);
    bytes[4] = ELFCLASS64;
    bytes[5] = ELFDATA2LSB;
    bytes[6] = 1;
    put(&mut bytes, 16, ET_DYN.to_le_bytes());
    put(&mut bytes, 18, machine.to_le_bytes());
    put(&mut bytes, 20, 1u32.to_le_bytes());
    put(&mut bytes, 40, (sections_offset as u64).to_le_bytes());
    put(&mut bytes, 52, (HEADER_SIZE as u16).to_le_bytes());
    put(&mut bytes, 58, (SECTION_HEADER_SIZE as u16).to_le_bytes());
    put(&mut bytes, 60, 3u16.to_le_bytes());

    for (index, (_, binding, defined)) in symbols.iter().enumerate() {
        let base = symbols_offset + index * SYMBOL_SIZE;
        put(&mut bytes, base, (names[index] as u32).to_le_bytes());
        bytes[base + 4] = (*binding << 4) | 2;
        put(&mut bytes, base + 6, u16::from(*defined).to_le_bytes());
    }
    bytes[strings_offset..sections_offset].copy_from_slice(&strings);

    let dynsym = sections_offset + SECTION_HEADER_SIZE;
    put(&mut bytes, at(dynsym, 4).unwrap(), SHT_DYNSYM.to_le_bytes());
    put(
        &mut bytes,
        at(dynsym, 24).unwrap(),
        (symbols_offset as u64).to_le_bytes(),
    );
    put(
        &mut bytes,
        at(dynsym, 32).unwrap(),
        ((symbols.len() * SYMBOL_SIZE) as u64).to_le_bytes(),
    );
    put(&mut bytes, at(dynsym, 40).unwrap(), 2u32.to_le_bytes());
    put(
        &mut bytes,
        at(dynsym, 56).unwrap(),
        (SYMBOL_SIZE as u64).to_le_bytes(),
    );

    let strtab = sections_offset + 2 * SECTION_HEADER_SIZE;
    put(&mut bytes, at(strtab, 4).unwrap(), SHT_STRTAB.to_le_bytes());
    put(
        &mut bytes,
        at(strtab, 24).unwrap(),
        (strings_offset as u64).to_le_bytes(),
    );
    put(
        &mut bytes,
        at(strtab, 32).unwrap(),
        (strings.len() as u64).to_le_bytes(),
    );
    bytes
}

fn fixture_symbols() -> Vec<(&'static str, u8, bool)> {
    let mut symbols: Vec<(&'static str, u8, bool)> = EXPECTED_EXPORTS
        .iter()
        .map(|name| (*name, 1, true))
        .collect();
    // Imports and local symbols must not be reported as exported entry points.
    symbols.push(("__cxa_atexit", 1, false));
    symbols.push(("local_helper", 0, true));
    symbols
}

fn parse(bytes: &[u8]) -> Result<Elf64, &'static str> {
    let ident: [u8; 16] = read(bytes, 0)?;
    if ident[0..4] != ELF_MAGIC {
        return Err("ELF magic bytes are absent");
    }
    if ident[4] != ELFCLASS64 {
        return Err("ELF class is not ELFCLASS64");
    }
    if ident[5] != ELFDATA2LSB {
        return Err("ELF data is not little-endian");
    }
    if ident[6] != 1 {
        return Err("ELF identification version is not 1");
    }
    if u16_at(bytes, 16)? != ET_DYN {
        return Err("ELF type is not ET_DYN");
    }
    let machine = u16_at(bytes, 18)?;
    if u32_at(bytes, 20)? != 1 {
        return Err("ELF version is not 1");
    }
    if usize::from(u16_at(bytes, 52)?) != HEADER_SIZE {
        return Err("ELF header size is not 64 bytes");
    }
    let sections_offset = usize_at(bytes, 40)?;
    let shnum = usize::from(u16_at(bytes, 60)?);
    if usize::from(u16_at(bytes, 58)?) != SECTION_HEADER_SIZE || shnum == 0 {
        return Err("section header table is missing or has an unexpected entry size");
    }

    let mut sections = Vec::with_capacity(shnum);
    for index in 0..shnum {
        let base = at(
            sections_offset,
            index
                .checked_mul(SECTION_HEADER_SIZE)
                .ok_or("section table overflow")?,
        )?;
        let section = Section {
            kind: u32_at(bytes, at(base, 4)?)?,
            offset: usize_at(bytes, at(base, 24)?)?,
            size: usize_at(bytes, at(base, 32)?)?,
            link: usize::try_from(u32_at(bytes, at(base, 40)?)?)
                .map_err(|_| "section link does not fit the host")?,
            ent_size: usize_at(bytes, at(base, 56)?)?,
        };
        // NOBITS sections occupy no file bytes, so their size is not a file bound.
        if section.kind != SHT_NOBITS && section.kind != SHT_NULL {
            let end = section
                .offset
                .checked_add(section.size)
                .ok_or("section range overflow")?;
            if end > bytes.len() {
                return Err("a section extends past the end of the file");
            }
        }
        sections.push(section);
    }

    let mut exports = BTreeSet::new();
    let mut found_dynsym = false;
    for section in &sections {
        if section.kind != SHT_DYNSYM {
            continue;
        }
        found_dynsym = true;
        let strings = sections
            .get(section.link)
            .ok_or("dynamic symbol table links to a missing section")?;
        if strings.kind != SHT_STRTAB {
            return Err("dynamic symbol table does not link to a string table");
        }
        if section.ent_size != SYMBOL_SIZE || section.size % SYMBOL_SIZE != 0 {
            return Err("dynamic symbol entries are not well-formed 24-byte records");
        }
        let string_data = bytes
            .get(strings.offset..at(strings.offset, strings.size)?)
            .ok_or("string table extends past the end of the file")?;
        let symbol_data = bytes
            .get(section.offset..at(section.offset, section.size)?)
            .ok_or("symbol table extends past the end of the file")?;
        for entry in symbol_data.chunks_exact(SYMBOL_SIZE) {
            let name_offset = usize::try_from(u32_at(entry, 0)?)
                .map_err(|_| "symbol name offset does not fit the host")?;
            let binding = entry[4] >> 4;
            // Undefined and local symbols are imports or internals, not exports.
            if u16_at(entry, 6)? == 0 || (binding != 1 && binding != 2) {
                continue;
            }
            let tail = string_data
                .get(name_offset..)
                .ok_or("symbol name offset is out of range")?;
            let end = tail
                .iter()
                .position(|&byte| byte == 0)
                .ok_or("symbol name is not NUL-terminated")?;
            let name = std::str::from_utf8(&tail[..end]).map_err(|_| "symbol name is not UTF-8")?;
            if !name.is_empty() {
                exports.insert(name.to_owned());
            }
        }
    }
    if !found_dynsym {
        return Err("ELF image has no dynamic symbol table");
    }
    Ok(Elf64 { machine, exports })
}

fn jni_libs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("android")
        .join("jniLibs")
}

fn with_byte(bytes: &[u8], offset: usize, value: u8) -> Vec<u8> {
    let mut copy = bytes.to_vec();
    copy[offset] = value;
    copy
}

fn with_u32(bytes: &[u8], offset: usize, value: u32) -> Vec<u8> {
    let mut copy = bytes.to_vec();
    put(&mut copy, offset, value.to_le_bytes());
    copy
}

#[test]
fn synthetic_elf64_exposes_defined_global_dynamic_symbols() {
    let bytes = synthetic_elf(EM_AARCH64, &fixture_symbols());
    let elf = parse(&bytes).expect("synthetic ELF64 image is valid");
    assert_eq!(elf.machine, EM_AARCH64);
    let expected: BTreeSet<String> = EXPECTED_EXPORTS
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(elf.exports, expected);
}

#[test]
fn malformed_elf64_images_are_rejected_with_a_reason() {
    let bytes = synthetic_elf(EM_X86_64, &fixture_symbols());
    let sections_offset = u64_at(&bytes, 40).unwrap() as usize;
    let dynsym = sections_offset + SECTION_HEADER_SIZE;
    let strtab = sections_offset + 2 * SECTION_HEADER_SIZE;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "magic",
            with_byte(&bytes, 0, 0),
            "ELF magic bytes are absent",
        ),
        (
            "32-bit class",
            with_byte(&bytes, 4, 1),
            "ELF class is not ELFCLASS64",
        ),
        (
            "big-endian data",
            with_byte(&bytes, 5, 2),
            "ELF data is not little-endian",
        ),
        (
            "identification version",
            with_byte(&bytes, 6, 0),
            "ELF identification version is not 1",
        ),
        (
            "executable type",
            with_byte(&bytes, 16, 2),
            "ELF type is not ET_DYN",
        ),
        ("version", with_byte(&bytes, 20, 0), "ELF version is not 1"),
        (
            "header size",
            with_byte(&bytes, 52, 0),
            "ELF header size is not 64 bytes",
        ),
        (
            "section header entry size",
            with_byte(&bytes, 58, 0),
            "section header table is missing or has an unexpected entry size",
        ),
        (
            "section header count",
            with_byte(&bytes, 60, 0),
            "section header table is missing or has an unexpected entry size",
        ),
        (
            "section table offset",
            with_u32(&bytes, 40, u32::MAX),
            "ELF image is truncated",
        ),
        (
            "string table link",
            with_byte(&bytes, dynsym + 40, 99),
            "dynamic symbol table links to a missing section",
        ),
        (
            "string table type",
            with_byte(&bytes, strtab + 4, SHT_NULL as u8),
            "dynamic symbol table does not link to a string table",
        ),
        (
            "symbol entry size",
            with_byte(&bytes, dynsym + 56, 0),
            "dynamic symbol entries are not well-formed 24-byte records",
        ),
        (
            "symbol name offset",
            with_u32(&bytes, HEADER_SIZE, u32::MAX),
            "symbol name offset is out of range",
        ),
        ("truncated", bytes[..20].to_vec(), "ELF image is truncated"),
    ];
    for (label, image, reason) in cases {
        assert_eq!(parse(&image).unwrap_err(), reason, "case {label}");
    }
}

#[test]
fn android_shared_objects_export_the_jni_and_c_abi_symbols() {
    let root = jni_libs_dir();
    if !root.exists() {
        eprintln!(
            "SKIP: {} does not exist; run the verifier with an Android NDK first.",
            root.display()
        );
        return;
    }
    for (abi, machine) in [("arm64-v8a", EM_AARCH64), ("x86_64", EM_X86_64)] {
        let path = root.join(abi).join("libopurom_mobile.so");
        if !path.exists() {
            eprintln!(
                "SKIP: {} does not exist; run the verifier with an Android NDK first.",
                path.display()
            );
            continue;
        }
        let bytes = fs::read(&path).expect("shared object is readable");
        let elf = parse(&bytes).unwrap_or_else(|reason| panic!("{}: {reason}", path.display()));
        assert_eq!(elf.machine, machine, "{} machine type", path.display());
        for name in EXPECTED_EXPORTS {
            assert!(
                elf.exports.contains(name),
                "{} does not export {name}",
                path.display()
            );
        }
    }
}
