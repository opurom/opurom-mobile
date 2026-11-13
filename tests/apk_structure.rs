//! APK/AAB ZIP central-directory integrity reader, in standard-library Rust.
//!
//! `verify.mjs` packages the Android build with `aapt2` and signs it with
//! `apksigner`; the Node suite checks signing, and the Rust suite checks ELF
//! and Mach-O members. This is the packaging-structure check: one reader walks
//! the end-of-central-directory record, cross-checks every central directory
//! header against its local header, verifies stored-entry CRC32, and reports
//! 4-byte alignment of uncompressed data. Synthetic in-memory archives drive
//! the reader on every host; the built APK is checked when it is present.

use std::fs;
use std::path::{Path, PathBuf};

const LFH_SIG: u32 = 0x0403_4b50;
const CDH_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD_LEN: usize = 22;
const LFH_LEN: usize = 30;
const CDH_LEN: usize = 46;
const MAX_COMMENT: usize = u16::MAX as usize;
const DATA_DESCRIPTOR: u16 = 0x0008;
const METHOD_STORED: u16 = 0;

#[derive(Debug, PartialEq, Eq)]
struct Entry {
    name: String,
    method: u16,
    crc32: u32,
    compressed_size: u32,
    uncompressed_size: u32,
    data_offset: usize,
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16, &'static str> {
    let end = at.checked_add(2).ok_or("offset overflow")?;
    let slice = bytes.get(at..end).ok_or("archive is truncated")?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, &'static str> {
    let end = at.checked_add(4).ok_or("offset overflow")?;
    let slice = bytes.get(at..end).ok_or("archive is truncated")?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/* The EOCD is the last fixed-size record, but a variable-length comment can
 * follow it, so the signature is searched backwards within the legal window
 * and a candidate counts only when its comment length ends exactly at EOF. */
fn eocd_offset(bytes: &[u8]) -> Result<usize, &'static str> {
    if bytes.len() < EOCD_LEN {
        return Err("archive is too short to be a zip");
    }
    let first = bytes.len() - EOCD_LEN - MAX_COMMENT.min(bytes.len() - EOCD_LEN);
    for at in (first..=bytes.len() - EOCD_LEN).rev() {
        if u32_at(bytes, at)? == EOCD_SIG {
            let comment = u16_at(bytes, at + 20)? as usize;
            if at + EOCD_LEN + comment == bytes.len() {
                return Ok(at);
            }
        }
    }
    Err("end of central directory record is missing")
}

fn crc32_of(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn parse_archive(bytes: &[u8]) -> Result<Vec<Entry>, &'static str> {
    let eocd = eocd_offset(bytes)?;
    let disk = u16_at(bytes, eocd + 4)?;
    let cd_disk = u16_at(bytes, eocd + 6)?;
    let here = u16_at(bytes, eocd + 8)?;
    let total = u16_at(bytes, eocd + 10)?;
    let cd_size = u32_at(bytes, eocd + 12)? as usize;
    let cd_offset = u32_at(bytes, eocd + 16)? as usize;
    if disk != 0 || cd_disk != 0 || here != total {
        return Err("multi-disk or split archives are not accepted");
    }
    if total == u16::MAX || cd_size == u32::MAX as usize || cd_offset == u32::MAX as usize {
        return Err("ZIP64 archives are not handled");
    }
    let cd_end = cd_offset
        .checked_add(cd_size)
        .ok_or("central directory size overflow")?;
    if cd_end > eocd {
        return Err("central directory overruns the end record");
    }

    let mut at = cd_offset;
    let mut entries = Vec::new();
    for _ in 0..total {
        if at + CDH_LEN > cd_end {
            return Err("central directory header is truncated");
        }
        if u32_at(bytes, at)? != CDH_SIG {
            return Err("central directory header signature is wrong");
        }
        let method = u16_at(bytes, at + 10)?;
        let crc32 = u32_at(bytes, at + 16)?;
        let compressed_size = u32_at(bytes, at + 20)?;
        let uncompressed_size = u32_at(bytes, at + 24)?;
        let name_len = u16_at(bytes, at + 28)? as usize;
        let extra_len = u16_at(bytes, at + 30)? as usize;
        let comment_len = u16_at(bytes, at + 32)? as usize;
        let local_offset = u32_at(bytes, at + 42)? as usize;
        let name_start = at + CDH_LEN;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or("entry name length overflow")?;
        let name_bytes = bytes
            .get(name_start..name_end)
            .ok_or("entry name is truncated")?;
        let name = std::str::from_utf8(name_bytes).map_err(|_| "entry name is not UTF-8")?;

        if u32_at(bytes, local_offset)? != LFH_SIG {
            return Err("local file header signature is wrong");
        }
        let local_flags = u16_at(bytes, local_offset + 6)?;
        let local_method = u16_at(bytes, local_offset + 8)?;
        let local_name_len = u16_at(bytes, local_offset + 26)? as usize;
        let local_extra_len = u16_at(bytes, local_offset + 28)? as usize;
        let data_offset = local_offset
            .checked_add(LFH_LEN + local_name_len + local_extra_len)
            .ok_or("local data offset overflow")?;
        let local_name = bytes
            .get(local_offset + LFH_LEN..local_offset + LFH_LEN + local_name_len)
            .ok_or("local entry name is truncated")?;
        if local_name != name_bytes {
            return Err("local entry name differs from the central directory");
        }
        if local_method != method {
            return Err("local compression method differs from the central directory");
        }
        if local_flags & DATA_DESCRIPTOR == 0
            && (u32_at(bytes, local_offset + 14)? != crc32
                || u32_at(bytes, local_offset + 18)? != compressed_size
                || u32_at(bytes, local_offset + 22)? != uncompressed_size)
        {
            return Err("local sizes or CRC32 differ from the central directory");
        }
        let data_end = data_offset
            .checked_add(compressed_size as usize)
            .ok_or("entry data offset overflow")?;
        if data_end > cd_offset {
            return Err("entry data overruns the central directory");
        }
        if method == METHOD_STORED {
            if compressed_size != uncompressed_size {
                return Err("stored entry sizes disagree");
            }
            let data = bytes
                .get(data_offset..data_end)
                .ok_or("stored entry data is truncated")?;
            if crc32_of(data) != crc32 {
                return Err("stored entry CRC32 mismatch");
            }
        }

        entries.push(Entry {
            name: name.to_owned(),
            method,
            crc32,
            compressed_size,
            uncompressed_size,
            data_offset,
        });
        let next = at
            .checked_add(CDH_LEN + name_len + extra_len + comment_len)
            .ok_or("central directory entry length overflow")?;
        if next > cd_end {
            return Err("central directory entry overruns the directory");
        }
        at = next;
    }
    if at != cd_end {
        return Err("central directory size does not match its entries");
    }
    Ok(entries)
}

fn require_entries(entries: &[Entry], wanted: &[&str]) -> Result<(), String> {
    for name in wanted {
        if !entries.iter().any(|entry| entry.name == *name) {
            return Err(format!("required entry {name} is missing"));
        }
    }
    Ok(())
}

/* zipalign keeps uncompressed entry data on a 4-byte boundary so the package
 * can be mapped straight from the archive; deflated data carries no such rule. */
fn stored_alignment(entries: &[Entry]) -> Result<(), String> {
    for entry in entries.iter().filter(|entry| entry.method == METHOD_STORED) {
        if entry.data_offset % 4 != 0 {
            return Err(format!(
                "stored entry {} data is not 4-byte aligned",
                entry.name
            ));
        }
    }
    Ok(())
}

/* Only the placeholder entry names are asserted; apksigner owns cryptographic
 * validity of the signature blocks. */
fn signing_placeholders(entries: &[Entry]) -> Result<(), String> {
    let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    if !names.contains(&"META-INF/MANIFEST.MF") {
        return Err("META-INF/MANIFEST.MF is missing".to_owned());
    }
    if !names
        .iter()
        .any(|name| name.starts_with("META-INF/") && name.ends_with(".SF"))
    {
        return Err("META-INF signature file is missing".to_owned());
    }
    if !names.iter().any(|name| {
        name.starts_with("META-INF/")
            && (name.ends_with(".RSA") || name.ends_with(".DSA") || name.ends_with(".EC"))
    }) {
        return Err("META-INF signature block is missing".to_owned());
    }
    Ok(())
}

fn entry_data(index: usize) -> Vec<u8> {
    (0..8 + index).map(|step| (index + step) as u8).collect()
}

/* Builds a stored-only archive. `align_stored` pads each local extra field so
 * the data starts on a 4-byte boundary, mirroring aapt2's zipalign output. */
fn synthetic_apk(entries: &[(&str, &[u8])], align_stored: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for &(name, data) in entries {
        let name_bytes = name.as_bytes();
        let local_offset = out.len() as u32;
        let crc = crc32_of(data);
        let base = out.len() + LFH_LEN + name_bytes.len();
        let extra_len = if align_stored { (4 - base % 4) % 4 } else { 0 };
        out.extend_from_slice(&LFH_SIG.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&METHOD_STORED.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&(extra_len as u16).to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend(std::iter::repeat(0u8).take(extra_len));
        out.extend_from_slice(data);
        central.push((name, crc, data.len() as u32, local_offset));
    }
    let cd_offset = out.len() as u32;
    for (name, crc, size, local_offset) in &central {
        let name_bytes = name.as_bytes();
        out.extend_from_slice(&CDH_SIG.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&METHOD_STORED.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&local_offset.to_le_bytes());
        out.extend_from_slice(name_bytes);
    }
    let cd_size = out.len() as u32 - cd_offset;
    out.extend_from_slice(&EOCD_SIG.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(central.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn with_u16(bytes: &[u8], at: usize, value: u16) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out[at..at + 2].copy_from_slice(&value.to_le_bytes());
    out
}

fn with_u32(bytes: &[u8], at: usize, value: u32) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out[at..at + 4].copy_from_slice(&value.to_le_bytes());
    out
}

fn with_byte(bytes: &[u8], at: usize, value: u8) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out[at] = value;
    out
}

const CORE: &[&str] = &[
    "AndroidManifest.xml",
    "resources.arsc",
    "classes.dex",
    "assets/todo.opuir.json",
    "META-INF/MANIFEST.MF",
    "META-INF/CERT.SF",
    "META-INF/CERT.RSA",
];

fn signed_apk(align_stored: bool) -> Vec<u8> {
    let data: Vec<Vec<u8>> = (0..CORE.len()).map(entry_data).collect();
    let entries: Vec<(&str, &[u8])> = CORE
        .iter()
        .zip(&data)
        .map(|(name, bytes)| (*name, bytes.as_slice()))
        .collect();
    synthetic_apk(&entries, align_stored)
}

#[test]
fn synthetic_signed_apk_passes_the_packaging_structure_check() {
    let bytes = signed_apk(true);
    let entries = parse_archive(&bytes).expect("synthetic APK central directory parses");
    assert_eq!(entries.len(), CORE.len());
    for (index, (entry, name)) in entries.iter().zip(CORE).enumerate() {
        assert_eq!(entry.name, *name);
        assert_eq!(entry.method, METHOD_STORED);
        assert_eq!(entry.compressed_size, entry.uncompressed_size);
        assert_eq!(entry.compressed_size as usize, 8 + index);
        assert_eq!(entry.crc32, crc32_of(&entry_data(index)));
    }
    require_entries(
        &entries,
        &[
            "AndroidManifest.xml",
            "resources.arsc",
            "classes.dex",
            "assets/todo.opuir.json",
        ],
    )
    .expect("core APK entries are present");
    stored_alignment(&entries).expect("stored entry data is 4-byte aligned");
    signing_placeholders(&entries).expect("signing placeholders are present");
}

#[test]
fn an_eocd_comment_does_not_hide_the_central_directory() {
    let mut bytes = signed_apk(true);
    let eocd = eocd_offset(&bytes).unwrap();
    let comment = b"opurom packaging structure check";
    bytes[eocd + 20..eocd + 22].copy_from_slice(&(comment.len() as u16).to_le_bytes());
    bytes.extend_from_slice(comment);
    let entries = parse_archive(&bytes).expect("archive with an EOCD comment parses");
    assert_eq!(entries.len(), CORE.len());
    require_entries(&entries, CORE).expect("all core entries survive the comment");
}

#[test]
fn malformed_zip_archives_are_rejected_with_a_reason() {
    let good = signed_apk(true);
    let eocd = eocd_offset(&good).unwrap();
    let cd_offset = u32_at(&good, eocd + 16).unwrap() as usize;
    let first_data = parse_archive(&good).unwrap()[0].data_offset;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "short image",
            vec![0u8; 4],
            "archive is too short to be a zip",
        ),
        (
            "EOCD signature",
            with_u32(&good, eocd, 0xdead_beef),
            "end of central directory record is missing",
        ),
        (
            "truncated EOCD",
            good[..good.len() - 1].to_vec(),
            "end of central directory record is missing",
        ),
        (
            "central directory size",
            with_u32(&good, eocd + 12, 0),
            "central directory header is truncated",
        ),
        (
            "central directory offset",
            with_u32(&good, eocd + 16, eocd as u32),
            "central directory overruns the end record",
        ),
        (
            "entry count",
            with_u16(
                &with_u16(&good, eocd + 8, CORE.len() as u16 + 1),
                eocd + 10,
                CORE.len() as u16 + 1,
            ),
            "central directory header is truncated",
        ),
        (
            "disk number",
            with_u16(&good, eocd + 4, 1),
            "multi-disk or split archives are not accepted",
        ),
        (
            "central signature",
            with_u32(&good, cd_offset, 0),
            "central directory header signature is wrong",
        ),
        (
            "local signature",
            with_u32(&good, 0, 0),
            "local file header signature is wrong",
        ),
        (
            "local name",
            with_byte(&good, LFH_LEN, b'X'),
            "local entry name differs from the central directory",
        ),
        (
            "local method",
            with_u16(&good, 8, 8),
            "local compression method differs from the central directory",
        ),
        (
            "local CRC32",
            with_u32(&good, 14, 0),
            "local sizes or CRC32 differ from the central directory",
        ),
        (
            "stored data",
            with_byte(&good, first_data, 0xff),
            "stored entry CRC32 mismatch",
        ),
        (
            "local offset",
            with_u32(&good, cd_offset + 42, cd_offset as u32),
            "local file header signature is wrong",
        ),
    ];
    for (label, bytes, reason) in cases {
        assert_eq!(
            parse_archive(&bytes).unwrap_err(),
            reason,
            "unexpected verdict for {label}"
        );
    }
}

#[test]
fn packaging_assertions_reject_missing_entries_and_misalignment() {
    let unsigned: Vec<(&str, &[u8])> = vec![
        ("AndroidManifest.xml", b"manifest"),
        ("resources.arsc", b"table"),
    ];
    let aligned = synthetic_apk(&unsigned, true);
    let entries = parse_archive(&aligned).unwrap();
    assert!(require_entries(&entries, CORE)
        .unwrap_err()
        .contains("classes.dex"));
    assert!(signing_placeholders(&entries)
        .unwrap_err()
        .contains("MANIFEST.MF"));
    stored_alignment(&entries).expect("aligned synthetic archive passes");

    let misaligned = synthetic_apk(&unsigned, false);
    let misaligned_entries = parse_archive(&misaligned).unwrap();
    assert!(
        stored_alignment(&misaligned_entries)
            .unwrap_err()
            .contains("not 4-byte aligned"),
        "an unaligned stored entry must be rejected"
    );
    require_entries(
        &misaligned_entries,
        &["AndroidManifest.xml", "resources.arsc"],
    )
    .expect("core entries are still present");
}

fn built_apk_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("verify")
        .join("aapt2")
        .join("linked")
        .join("app.apk")
}

#[test]
fn built_apk_has_valid_central_directory_and_aligned_stored_data() {
    let path = built_apk_path();
    if !path.exists() {
        eprintln!(
            "SKIP: {} does not exist; run `node verify.mjs` with the Android SDK first.",
            path.display()
        );
        return;
    }
    let bytes = fs::read(&path).expect("built APK is readable");
    let entries = parse_archive(&bytes).expect("built APK central directory parses");
    require_entries(
        &entries,
        &[
            "AndroidManifest.xml",
            "resources.arsc",
            "assets/todo.opuir.json",
        ],
    )
    .expect("built APK carries its manifest, resource table and IR asset");
    stored_alignment(&entries).expect("built APK stored entries are 4-byte aligned");
    let table = entries
        .iter()
        .find(|entry| entry.name == "resources.arsc")
        .unwrap();
    assert_eq!(table.method, METHOD_STORED);
}
