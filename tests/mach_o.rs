//! Mach-O64 evidence for the iOS static library archive.
//!
//! `verify.mjs` checks the `aarch64-apple-ios` archive with `file`, `lipo` and
//! `otool`. This test parses the archive and every object member with
//! standard-library Rust only, so the same evidence is available on a host
//! without those tools. Synthetic in-memory images exercise the reader on
//! every host; the built archive is checked when the iOS build has produced it.
//! The archive also carries the C ABI symbol names the Swift wrapper binds to,
//! read straight from each object's `LC_SYMTAB`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const AR_MAGIC: [u8; 8] = *b"!<arch>\n";
const AR_HEADER_SIZE: usize = 60;
const AR_TERMINATOR: [u8; 2] = *b"`\n";

const MH_MAGIC_64: u32 = 0xfeedfacf;
/// The same magic bytes read in the opposite byte order, i.e. a big-endian image.
const MH_CIGAM_64: u32 = 0xcffaedfe;
const MH_OBJECT: u32 = 1;
const CPU_TYPE_ARM64: u32 = 0x0100_000c;
const LC_SEGMENT_64: u32 = 0x19;
const LC_VERSION_MIN_IPHONEOS: u32 = 0x25;
const LC_VERSION_MIN_MACOSX: u32 = 0x24;
const LC_BUILD_VERSION: u32 = 0x32;
/// Platform value in an `LC_BUILD_VERSION` record for iOS binaries.
const PLATFORM_IOS: u32 = 2;
const HEADER_SIZE: usize = 32;

#[derive(Debug, PartialEq, Eq)]
enum Platform {
    VersionMinIphoneos,
    BuildVersion(u32),
}

#[derive(Debug)]
struct MachO64 {
    cputype: u32,
    filetype: u32,
    segments: usize,
    platform: Option<Platform>,
}

struct ArchiveMember {
    name: String,
    data: Vec<u8>,
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, &'static str> {
    let end = offset.checked_add(4).ok_or("Mach-O image is truncated")?;
    let slice = bytes.get(offset..end).ok_or("Mach-O image is truncated")?;
    let raw: [u8; 4] = slice.try_into().expect("a slice of 4 bytes is [u8; 4]");
    Ok(u32::from_le_bytes(raw))
}

/// Symbol-index and string-table members carry no object bytes.
fn is_symbol_index(name: &str) -> bool {
    name == "/" || name == "//" || name == "/SYMDEF/" || name.starts_with("__.SYMDEF")
}

/// Trims the padding that `ar` writes around member names.
fn name_from_bytes(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.trim_end_matches(&['\0', ' ', '\n'][..]).to_owned()
}

/// Walks a static archive and returns the object members with their names.
/// The BSD `ar` format keeps long names in `#1/<len>` prefixed member data;
/// a GNU `/123` reference has no table to resolve here and is rejected.
fn parse_archive(bytes: &[u8]) -> Result<Vec<ArchiveMember>, &'static str> {
    if bytes.len() < AR_MAGIC.len() || bytes[0..8] != AR_MAGIC {
        return Err("archive magic is not `!<arch>`");
    }
    let mut members = Vec::new();
    let mut offset = AR_MAGIC.len();
    while offset < bytes.len() {
        if bytes.len() - offset < AR_HEADER_SIZE {
            return Err("member header is truncated");
        }
        if bytes[offset + 58..offset + 60] != AR_TERMINATOR {
            return Err("member header terminator is missing");
        }
        let size_field = std::str::from_utf8(&bytes[offset + 48..offset + 58])
            .map_err(|_| "member size is not a decimal number")?
            .trim();
        let size = usize::from_str_radix(size_field, 10)
            .map_err(|_| "member size is not a decimal number")?;
        let name_field = name_from_bytes(&bytes[offset..offset + 16]);
        offset += AR_HEADER_SIZE;
        let data_end = offset.checked_add(size).ok_or("member data is truncated")?;
        if data_end > bytes.len() {
            return Err("member data is truncated");
        }
        let stored = &bytes[offset..data_end];
        offset = data_end + (size % 2);
        let (name, data) = if let Some(len_field) = name_field.strip_prefix("#1/") {
            let name_len = usize::from_str_radix(len_field.trim(), 10)
                .map_err(|_| "member name length is not a decimal number")?;
            if name_len > stored.len() {
                return Err("member name is truncated");
            }
            (name_from_bytes(&stored[..name_len]), &stored[name_len..])
        } else {
            (name_field, stored)
        };
        if name.starts_with('/') && !is_symbol_index(&name) {
            return Err("GNU long-name references are not handled");
        }
        if is_symbol_index(&name) {
            continue;
        }
        members.push(ArchiveMember {
            name,
            data: data.to_vec(),
        });
    }
    Ok(members)
}

fn object_members(bytes: &[u8]) -> Result<Vec<ArchiveMember>, &'static str> {
    let members = parse_archive(bytes)?;
    if members.is_empty() {
        return Err("static archive has no object members");
    }
    Ok(members)
}

/// Parses one Mach-O64 image and requires the shape of an iOS object file:
/// arm64, `MH_OBJECT`, at least one `LC_SEGMENT_64`, and an iOS platform
/// command. Object members carry no `LC_UUID`; that command belongs to linked
/// dylibs and executables.
fn ios_object(data: &[u8]) -> Result<MachO64, &'static str> {
    if data.len() < HEADER_SIZE {
        return Err("Mach-O header is truncated");
    }
    let magic = u32_at(data, 0)?;
    if magic == MH_CIGAM_64 {
        return Err("Mach-O magic byte order is not little-endian");
    }
    if magic != MH_MAGIC_64 {
        return Err("Mach-O magic bytes are absent");
    }
    let cputype = u32_at(data, 4)?;
    if cputype != CPU_TYPE_ARM64 {
        return Err("Mach-O cpu type is not arm64");
    }
    let filetype = u32_at(data, 12)?;
    if filetype != MH_OBJECT {
        return Err("Mach-O file type is not MH_OBJECT");
    }
    let command_count = u32_at(data, 16)? as usize;
    let commands_size = u32_at(data, 20)? as usize;
    let region_end = HEADER_SIZE
        .checked_add(commands_size)
        .ok_or("load command region overflow")?;
    if region_end > data.len() {
        return Err("load command region extends past the member end");
    }
    let mut segments = 0;
    let mut platform = None;
    let mut offset = HEADER_SIZE;
    for _ in 0..command_count {
        let command = u32_at(data, offset)?;
        let command_size = u32_at(data, offset + 4)? as usize;
        if command_size < 8 {
            return Err("load command size is smaller than 8 bytes");
        }
        // The 64-bit format keeps every load command 8-byte aligned.
        if command_size % 8 != 0 {
            return Err("load command size is not a multiple of 8");
        }
        let next = offset
            .checked_add(command_size)
            .ok_or("load command range overflow")?;
        if next > region_end {
            return Err("load commands extend past the declared size");
        }
        if command == LC_SEGMENT_64 {
            segments += 1;
        }
        if command == LC_VERSION_MIN_IPHONEOS {
            platform = Some(Platform::VersionMinIphoneos);
        }
        if command == LC_BUILD_VERSION {
            platform = Some(Platform::BuildVersion(u32_at(data, offset + 8)?));
        }
        offset = next;
    }
    if segments == 0 {
        return Err("Mach-O object has no LC_SEGMENT_64 load command");
    }
    match platform {
        None => Err("Mach-O object has no iOS platform load command"),
        Some(Platform::BuildVersion(value)) if value != PLATFORM_IOS => {
            Err("LC_BUILD_VERSION platform is not iOS")
        }
        Some(_) => Ok(MachO64 {
            cputype,
            filetype,
            segments,
            platform,
        }),
    }
}

fn put_u32(bytes: &mut Vec<u8>, offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

/// One load command: the fixed `cmd`/`cmdsize` pair followed by its payload.
fn load_command(command: u32, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0u8; 8 + payload.len()];
    put_u32(&mut bytes, 0, command);
    put_u32(&mut bytes, 4, (8 + payload.len()) as u32);
    bytes[8..].copy_from_slice(payload);
    bytes
}

/// An unnamed segment with no sections; the shipped objects carry their
/// section names at the section level, so the segment name stays empty.
fn segment_64_command() -> Vec<u8> {
    load_command(LC_SEGMENT_64, &[0u8; 64])
}

fn version_min_command(kind: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0x000c_0000u32.to_le_bytes()); // version 12.0.0
    payload.extend_from_slice(&0x000d_0200u32.to_le_bytes()); // SDK 13.2.0
    load_command(kind, &payload)
}

fn build_version_command(platform: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&platform.to_le_bytes());
    payload.extend_from_slice(&0x000c_0000u32.to_le_bytes()); // minos 12.0.0
    payload.extend_from_slice(&0x000d_0200u32.to_le_bytes()); // SDK 13.2.0
    payload.extend_from_slice(&0u32.to_le_bytes()); // no tool entries
    load_command(LC_BUILD_VERSION, &payload)
}

fn synthetic_object(commands: &[&[u8]]) -> Vec<u8> {
    let commands_size: usize = commands.iter().map(|command| command.len()).sum();
    let mut bytes = vec![0u8; HEADER_SIZE + commands_size];
    put_u32(&mut bytes, 0, MH_MAGIC_64);
    put_u32(&mut bytes, 4, CPU_TYPE_ARM64);
    put_u32(&mut bytes, 12, MH_OBJECT);
    put_u32(&mut bytes, 16, commands.len() as u32);
    put_u32(&mut bytes, 20, commands_size as u32);
    let mut offset = HEADER_SIZE;
    for command in commands {
        bytes[offset..offset + command.len()].copy_from_slice(command);
        offset += command.len();
    }
    bytes
}

/// Builds a BSD `ar` archive; long names use the `#1/<len>` member form and
/// short names stay in the 16-byte header field.
fn synthetic_archive(members: &[(&str, &[u8])]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&AR_MAGIC);
    for (name, data) in members {
        let mut header = [b' '; AR_HEADER_SIZE];
        let record;
        if name.len() > 16 {
            let marker = format!("#1/{}", name.len());
            header[..marker.len()].copy_from_slice(marker.as_bytes());
            let mut stored = name.as_bytes().to_vec();
            stored.extend_from_slice(data);
            record = stored;
        } else {
            header[..name.len()].copy_from_slice(name.as_bytes());
            record = data.to_vec();
        }
        let size_text = format!("{:<10}", record.len());
        header[48..58].copy_from_slice(size_text.as_bytes());
        header[58..60].copy_from_slice(&AR_TERMINATOR);
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(&record);
        if record.len() % 2 == 1 {
            bytes.push(b'\n');
        }
    }
    bytes
}

fn with_u32(bytes: &[u8], offset: usize, value: u32) -> Vec<u8> {
    let mut copy = bytes.to_vec();
    copy[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    copy
}

fn valid_object() -> Vec<u8> {
    let segment = segment_64_command();
    let version = version_min_command(LC_VERSION_MIN_IPHONEOS);
    synthetic_object(&[&segment, &version])
}

#[test]
fn synthetic_ios_objects_pass_the_mach_o_checks() {
    let bytes = valid_object();
    let object = ios_object(&bytes).expect("synthetic iPhoneOS object is valid");
    assert_eq!(object.cputype, CPU_TYPE_ARM64);
    assert_eq!(object.filetype, MH_OBJECT);
    assert_eq!(object.segments, 1);
    assert_eq!(object.platform, Some(Platform::VersionMinIphoneos));

    let segment = segment_64_command();
    let build = build_version_command(PLATFORM_IOS);
    let object = ios_object(&synthetic_object(&[&segment, &build]))
        .expect("LC_BUILD_VERSION records the iOS platform");
    assert_eq!(object.platform, Some(Platform::BuildVersion(PLATFORM_IOS)));

    // The archive walk must resolve long and short member names and skip the
    // symbol-index and string-table members.
    let long_name = "opurom_mobile-5fc2e40fa7403e02.opurom_mobile.703f2818885f5440-cgu.0.rcgu.o";
    let index_data = [0u8; 40];
    let table_data = b"text.o/\n".as_slice();
    let archive = synthetic_archive(&[
        ("short.o", &bytes),
        (long_name, &build),
        ("__.SYMDEF", &index_data),
        ("//", table_data),
    ]);
    let members = object_members(&archive).expect("synthetic archive is valid");
    let names: Vec<&str> = members.iter().map(|member| member.name.as_str()).collect();
    assert_eq!(names, ["short.o", long_name]);
}

#[test]
fn malformed_archives_are_rejected_with_a_reason() {
    let bytes = synthetic_archive(&[("short.o", &valid_object())]);
    let bad_terminator = {
        let mut copy = bytes.clone();
        copy[8 + 58] = b'!';
        copy
    };
    let bad_size_field = {
        let mut copy = bytes.clone();
        copy[8 + 48..8 + 58].copy_from_slice(b"0x1234    ");
        copy
    };
    let oversized_member = {
        let mut copy = bytes.clone();
        copy[8 + 48..8 + 58].copy_from_slice(b"500000    ");
        copy
    };
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "archive magic",
            with_u32(&bytes, 0, 0x1234_5678),
            "archive magic is not `!<arch>`",
        ),
        (
            "member terminator",
            bad_terminator,
            "member header terminator is missing",
        ),
        (
            "member size",
            bad_size_field,
            "member size is not a decimal number",
        ),
        (
            "member data truncated",
            oversized_member,
            "member data is truncated",
        ),
        (
            "GNU long-name reference",
            synthetic_archive(&[("/123", &valid_object())]),
            "GNU long-name references are not handled",
        ),
        (
            "header truncated",
            bytes[..48].to_vec(),
            "member header is truncated",
        ),
        (
            "empty archive",
            AR_MAGIC.to_vec(),
            "static archive has no object members",
        ),
    ];
    for (label, image, reason) in cases {
        assert_eq!(object_members(&image).err(), Some(reason), "case {label}");
    }
}

#[test]
fn malformed_mach_o_images_are_rejected_with_a_reason() {
    let bytes = valid_object();
    // The second load command starts after the 72-byte segment command.
    let second_command = HEADER_SIZE + 72;
    let segment = segment_64_command();
    let macos = version_min_command(LC_VERSION_MIN_MACOSX);
    let macos_build = build_version_command(1);
    let no_segment = synthetic_object(&[&version_min_command(LC_VERSION_MIN_IPHONEOS)]);
    let macos_only = synthetic_object(&[&segment, &macos]);
    let macos_build_only = synthetic_object(&[&segment, &macos_build]);
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "truncated",
            bytes[..20].to_vec(),
            "Mach-O header is truncated",
        ),
        (
            "foreign magic",
            with_u32(&bytes, 0, 0x464c_457f),
            "Mach-O magic bytes are absent",
        ),
        (
            "byte order",
            with_u32(&bytes, 0, MH_CIGAM_64),
            "Mach-O magic byte order is not little-endian",
        ),
        (
            "cpu type",
            with_u32(&bytes, 4, 0x0100_0007),
            "Mach-O cpu type is not arm64",
        ),
        (
            "file type",
            with_u32(&bytes, 12, 2),
            "Mach-O file type is not MH_OBJECT",
        ),
        (
            "command region",
            with_u32(&bytes, 20, u32::MAX),
            "load command region extends past the member end",
        ),
        (
            "command count",
            with_u32(&bytes, 16, 10),
            "Mach-O image is truncated",
        ),
        (
            "command size zero",
            with_u32(&bytes, second_command + 4, 0),
            "load command size is smaller than 8 bytes",
        ),
        (
            "command alignment",
            with_u32(&bytes, second_command + 4, 12),
            "load command size is not a multiple of 8",
        ),
        (
            "command size overflow",
            with_u32(&bytes, second_command + 4, 72),
            "load commands extend past the declared size",
        ),
        (
            "no segment",
            no_segment,
            "Mach-O object has no LC_SEGMENT_64 load command",
        ),
        (
            "macOS platform",
            macos_only,
            "Mach-O object has no iOS platform load command",
        ),
        (
            "macOS build platform",
            macos_build_only,
            "LC_BUILD_VERSION platform is not iOS",
        ),
    ];
    for (label, image, reason) in cases {
        assert_eq!(ios_object(&image).err(), Some(reason), "case {label}");
    }
}

#[test]
fn ios_staticlib_members_are_arm64_mach_o_objects_with_ios_load_commands() {
    let path = archive_path();
    if !path.exists() {
        eprintln!(
            "SKIP: {} does not exist; run `node verify.mjs` on a macOS host first.",
            path.display()
        );
        return;
    }
    let bytes = fs::read(&path).expect("static archive is readable");
    let members =
        object_members(&bytes).unwrap_or_else(|reason| panic!("{}: {reason}", path.display()));
    for member in &members {
        ios_object(&member.data)
            .unwrap_or_else(|reason| panic!("{} ({}): {reason}", path.display(), member.name));
    }
    eprintln!(
        "checked {} Mach-O64 object members in {}",
        members.len(),
        path.display()
    );
}

fn archive_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("aarch64-apple-ios")
        .join("release")
        .join("libopurom_mobile.a")
}

/// The C ABI symbols the Swift wrapper binds to. Mach-O prefixes C symbols with
/// a leading underscore, so the nlist names are the underscore-qualified forms.
const EXPECTED_DEFINED: [&str; 8] = [
    "_opu_state_new",
    "_opu_dispatch",
    "_opu_frame",
    "_opu_state_free",
    "_opu_renderer_new",
    "_opu_renderer_frame",
    "_opu_renderer_free",
    "_opu_frame_from_ir",
];

const LC_SYMTAB: u32 = 0x02;
const NLIST64_SIZE: usize = 16;
/// Mask for the type bits folded into `n_type`.
const N_TYPE: u8 = 0x0e;
/// Undefined symbol type; the symbol is an import, not a definition.
const N_UNDF: u8 = 0x00;
/// Local scope bit; local symbols are not exported entry points.
const N_LOCAL: u8 = 0x80;

/// Read one object member's `LC_SYMTAB` and return the names of its defined
/// global symbols, the set `nm` prints for a Mach-O object. The type and scope
/// bits share the `n_type` field, so a name counts as defined only when its
/// type is not undefined and its scope is not local.
fn defined_symbols(data: &[u8]) -> Result<BTreeSet<String>, &'static str> {
    ios_object(data)?;
    let command_count = u32_at(data, 16)? as usize;
    let commands_size = u32_at(data, 20)? as usize;
    let region_end = HEADER_SIZE
        .checked_add(commands_size)
        .ok_or("load command region overflow")?;
    if region_end > data.len() {
        return Err("load command region extends past the member end");
    }
    let mut found = false;
    let mut nsyms = 0u32;
    let mut symoff = 0usize;
    let mut stroff = 0usize;
    let mut strsize = 0usize;
    let mut offset = HEADER_SIZE;
    for _ in 0..command_count {
        let command = u32_at(data, offset)?;
        let command_size = u32_at(data, offset + 4)? as usize;
        if command_size < 8 || command_size % 8 != 0 {
            return Err("load command size is not a multiple of 8");
        }
        let next = offset
            .checked_add(command_size)
            .ok_or("load command range overflow")?;
        if next > region_end {
            return Err("load commands extend past the declared size");
        }
        if command == LC_SYMTAB {
            if command_size < 8 + 16 {
                return Err("LC_SYMTAB command is shorter than 24 bytes");
            }
            symoff = usize::try_from(u32_at(data, offset + 8)?)
                .map_err(|_| "symbol table offset does not fit the host")?;
            nsyms = u32_at(data, offset + 12)?;
            stroff = usize::try_from(u32_at(data, offset + 16)?)
                .map_err(|_| "string table offset does not fit the host")?;
            strsize = usize::try_from(u32_at(data, offset + 20)?)
                .map_err(|_| "string table size does not fit the host")?;
            found = true;
        }
        offset = next;
    }
    if !found {
        return Err("Mach-O object has no LC_SYMTAB load command");
    }
    let entries = usize::try_from(nsyms)
        .map_err(|_| "symbol table count does not fit the host")?
        .checked_mul(NLIST64_SIZE)
        .ok_or("symbol table range overflow")?;
    let symbols = data
        .get(
            symoff
                ..symoff
                    .checked_add(entries)
                    .ok_or("symbol table range overflow")?,
        )
        .ok_or("symbol table extends past the member end")?;
    let strings = data
        .get(
            stroff
                ..stroff
                    .checked_add(strsize)
                    .ok_or("string table range overflow")?,
        )
        .ok_or("symbol string table extends past the member end")?;
    let mut defined = BTreeSet::new();
    for entry in symbols.chunks_exact(NLIST64_SIZE) {
        let n_type = entry[4];
        if (n_type & N_TYPE) == N_UNDF || (n_type & N_LOCAL) != 0 {
            continue;
        }
        let name_offset = usize::try_from(u32_at(entry, 0)?)
            .map_err(|_| "symbol name offset does not fit the host")?;
        let tail = strings
            .get(name_offset..)
            .ok_or("symbol name offset is out of range")?;
        let end = tail
            .iter()
            .position(|&byte| byte == 0)
            .ok_or("symbol name is not NUL-terminated")?;
        let name = std::str::from_utf8(&tail[..end]).map_err(|_| "symbol name is not UTF-8")?;
        if !name.is_empty() {
            defined.insert(name.to_owned());
        }
    }
    Ok(defined)
}

/// One `LC_SYMTAB` load command: the fixed pair plus its four payload fields,
/// written in the on-disk `symoff`, `nsyms`, `stroff`, `strsize` order.
fn symtab_command(symoff: u32, nsyms: u32, stroff: u32, strsize: u32) -> Vec<u8> {
    let payload = [symoff, nsyms, stroff, strsize]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect::<Vec<u8>>();
    load_command(LC_SYMTAB, &payload)
}

/// Builds a synthetic object with a symbol table, a string table and symbol
/// entries, so the reader runs without build output. Each entry is an
/// `(name, n_type)` pair; undefined and local entries must not be reported.
fn synthetic_object_with_symbols(entries: &[(&str, u8)]) -> Vec<u8> {
    let mut strings = vec![0u8];
    let mut name_offsets = Vec::with_capacity(entries.len());
    for (name, _) in entries {
        name_offsets.push(strings.len() as u32);
        strings.extend_from_slice(name.as_bytes());
        strings.push(0);
    }
    let segment = segment_64_command();
    let version = version_min_command(LC_VERSION_MIN_IPHONEOS);
    let symtab = {
        let command_end = HEADER_SIZE + segment.len() + version.len() + 24;
        let symoff = command_end as u32;
        let stroff = symoff + entries.len() as u32 * NLIST64_SIZE as u32;
        symtab_command(symoff, entries.len() as u32, stroff, strings.len() as u32)
    };
    let command_end = HEADER_SIZE + segment.len() + version.len() + symtab.len();
    let mut bytes = synthetic_object(&[&segment, &version, &symtab]);
    bytes.resize(
        command_end + entries.len() * NLIST64_SIZE + strings.len(),
        0,
    );
    for (index, (_, n_type)) in entries.iter().enumerate() {
        let base = command_end + index * NLIST64_SIZE;
        put_u32(&mut bytes, base, name_offsets[index]);
        bytes[base + 4] = *n_type;
    }
    bytes[command_end + entries.len() * NLIST64_SIZE..].copy_from_slice(&strings);
    bytes
}

fn with_byte(bytes: &[u8], offset: usize, value: u8) -> Vec<u8> {
    let mut copy = bytes.to_vec();
    copy[offset] = value;
    copy
}

#[test]
fn synthetic_mach_o_objects_expose_defined_global_symbols() {
    // 0x2e is a defined global section symbol, 0x20 an undefined global import,
    // 0x8e a local section symbol and 0x02 a defined absolute symbol.
    let bytes = synthetic_object_with_symbols(&[
        ("_opu_state_new", 0x2e),
        ("_opu_dispatch", 0x2e),
        ("_opu_state_free", 0x20),
        ("_local_helper", 0x8e),
        ("_abs_value", 0x02),
    ]);
    let defined = defined_symbols(&bytes).expect("synthetic symbol table is valid");
    let expected: BTreeSet<String> = ["_opu_state_new", "_opu_dispatch", "_abs_value"]
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(defined, expected);

    let archive = synthetic_archive(&[("member.o", &bytes)]);
    let mut union = BTreeSet::new();
    for member in object_members(&archive).expect("synthetic archive is valid") {
        for name in defined_symbols(&member.data).expect("member symbol table is valid") {
            union.insert(name);
        }
    }
    assert_eq!(union, expected);
}

#[test]
fn malformed_mach_o_symbol_tables_are_rejected_with_a_reason() {
    let bytes = synthetic_object_with_symbols(&[("_opu_state_new", 0x2e)]);
    let segment = segment_64_command();
    let version = version_min_command(LC_VERSION_MIN_IPHONEOS);
    let symtab_offset = HEADER_SIZE + segment.len() + version.len();
    let symbol_offset = symtab_offset + 24;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "no symbol command",
            valid_object(),
            "Mach-O object has no LC_SYMTAB load command",
        ),
        (
            "symbol count",
            with_u32(&bytes, symtab_offset + 12, u32::MAX),
            "symbol table extends past the member end",
        ),
        (
            "symbol offset",
            with_u32(&bytes, symtab_offset + 8, u32::MAX),
            "symbol table extends past the member end",
        ),
        (
            "string offset",
            with_u32(&bytes, symtab_offset + 16, u32::MAX),
            "symbol string table extends past the member end",
        ),
        (
            "string size",
            with_u32(&bytes, symtab_offset + 20, u32::MAX),
            "symbol string table extends past the member end",
        ),
        (
            "name offset",
            with_u32(&bytes, symbol_offset, u32::MAX),
            "symbol name offset is out of range",
        ),
        (
            "name terminator",
            with_byte(&bytes, symbol_offset + NLIST64_SIZE + 15, b'x'),
            "symbol name is not NUL-terminated",
        ),
    ];
    for (label, image, reason) in cases {
        assert_eq!(defined_symbols(&image).unwrap_err(), reason, "case {label}");
    }
}

#[test]
fn ios_staticlib_defines_the_c_abi_symbols() {
    let path = archive_path();
    if !path.exists() {
        eprintln!(
            "SKIP: {} does not exist; run `node verify.mjs` on a macOS host first.",
            path.display()
        );
        return;
    }
    let bytes = fs::read(&path).expect("static archive is readable");
    let members =
        object_members(&bytes).unwrap_or_else(|reason| panic!("{}: {reason}", path.display()));
    let mut defined = BTreeSet::new();
    for member in &members {
        for name in defined_symbols(&member.data)
            .unwrap_or_else(|reason| panic!("{} ({}): {reason}", path.display(), member.name))
        {
            defined.insert(name);
        }
    }
    for name in EXPECTED_DEFINED {
        assert!(
            defined.contains(name),
            "{} does not define {name}",
            path.display()
        );
    }
    eprintln!(
        "checked {} defined symbols across {} members in {}",
        defined.len(),
        members.len(),
        path.display()
    );
}
