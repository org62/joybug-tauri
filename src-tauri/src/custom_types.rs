//! User-defined types: model, persistence, a small C-like parser, and a resolver
//! that turns a definition into the same `TypeLayoutData` shape the PDB types use,
//! so custom and PDB types render and overlay through one UI path.

use crate::commands::types::{TypeClassData, TypeLayoutData, TypeMemberData, TypeRefData};
use std::sync::Mutex;

/// One field of a user-defined type.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CustomFieldDef {
    pub name: String,
    /// Type expression: a primitive alias or a PDB/custom type name, with optional
    /// trailing `*` (pointer) and `[N]` (array). e.g. `u32`, `void*`, `wchar_t[16]`,
    /// `_LIST_ENTRY`.
    pub type_expr: String,
    /// Explicit byte offset; when `None` the field is packed sequentially with
    /// natural alignment.
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// A user-defined struct/union type.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CustomTypeDef {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub fields: Vec<CustomFieldDef>,
    /// `false` = struct (sequential offsets), `true` = union (all fields at 0).
    #[serde(default)]
    pub is_union: bool,
    /// Explicit total size; `None` = computed from fields.
    #[serde(default)]
    pub size: Option<u32>,
    #[serde(default)]
    pub comment: Option<String>,
}

// -------------------------------------------------------------------------
// Persistence (app-global — a definition is reusable across sessions)
// -------------------------------------------------------------------------

const CUSTOM_TYPES_FILE: &str = "custom_types.json";

/// Parsed-file cache: `load_custom_types` runs on every type lookup (custom names
/// shadow PDB names), so avoid re-reading the file each time. `save_custom_types`
/// is the only writer and keeps the cache in sync.
static CACHE: Mutex<Option<Vec<CustomTypeDef>>> = Mutex::new(None);

pub fn load_custom_types() -> Vec<CustomTypeDef> {
    let mut cache = CACHE.lock().unwrap();
    if cache.is_none() {
        *cache = Some(crate::data_dir::load_json(CUSTOM_TYPES_FILE));
    }
    cache.as_ref().unwrap().clone()
}

pub fn save_custom_types(types: &[CustomTypeDef]) {
    crate::data_dir::save_json(CUSTOM_TYPES_FILE, types);
    *CACHE.lock().unwrap() = Some(types.to_vec());
}

// -------------------------------------------------------------------------
// Type-expression parsing
// -------------------------------------------------------------------------

/// A parsed type expression: a base type name, pointer depth, and optional array count.
struct ParsedTypeExpr {
    base: String,
    pointer: bool,
    array_count: Option<u32>,
}

fn parse_type_expr(expr: &str) -> ParsedTypeExpr {
    let mut s = expr.trim().to_string();

    // Trailing array: `[N]`
    let mut array_count = None;
    if let Some(open) = s.rfind('[') {
        if let Some(close) = s[open..].find(']') {
            let inner = s[open + 1..open + close].trim();
            array_count = inner.parse::<u32>().ok().or(Some(0));
            s.truncate(open);
            s = s.trim().to_string();
        }
    }

    // Pointer stars anywhere (collapse `**` to a single pointer for rendering).
    let pointer = s.contains('*') || s.to_lowercase().ends_with("ptr");
    let base = s.replace('*', "").trim().to_string();

    ParsedTypeExpr {
        base,
        pointer,
        array_count,
    }
}

/// Resolve a primitive alias to a leaf `TypeRefData`. Case-insensitive; accepts C,
/// stdint, and Windows names.
fn primitive_ref(base: &str) -> Option<TypeRefData> {
    let key = base.trim().to_lowercase();
    let key = key.as_str();
    let (name, size, class): (&str, u32, TypeClassData) = match key {
        "void" => ("void", 0, TypeClassData::Void),
        "bool" | "boolean" | "_bool" => ("bool", 1, TypeClassData::Bool),
        "char" | "int8" | "int8_t" | "i8" | "__int8" | "signed char" => ("char", 1, TypeClassData::Char),
        "u8" | "uint8" | "uint8_t" | "byte" | "uchar" | "unsigned char" => {
            ("unsigned char", 1, TypeClassData::UInt)
        }
        "wchar" | "wchar_t" | "wchar16" | "char16_t" => ("wchar_t", 2, TypeClassData::WChar),
        "i16" | "int16" | "int16_t" | "short" | "short int" | "__int16" => ("short", 2, TypeClassData::Int),
        "u16" | "uint16" | "uint16_t" | "word" | "ushort" | "unsigned short" => {
            ("unsigned short", 2, TypeClassData::UInt)
        }
        "i32" | "int32" | "int32_t" | "int" | "long" | "long int" | "__int32" | "long32" => {
            ("int", 4, TypeClassData::Int)
        }
        "u32" | "uint32" | "uint32_t" | "dword" | "uint" | "unsigned" | "unsigned int"
        | "unsigned long" | "ulong" | "ulong32" => ("unsigned long", 4, TypeClassData::UInt),
        "i64" | "int64" | "int64_t" | "__int64" | "longlong" | "long long" | "quad" => {
            ("__int64", 8, TypeClassData::Int)
        }
        "u64" | "uint64" | "uint64_t" | "qword" | "ulonglong" | "unsigned long long"
        | "ulong64" | "size_t" | "uintptr_t" => ("unsigned __int64", 8, TypeClassData::UInt),
        "f32" | "float" => ("float", 4, TypeClassData::Float),
        "f64" | "double" => ("double", 8, TypeClassData::Float),
        "ptr" | "pointer" | "pvoid" | "lpvoid" | "handle" | "hmodule" | "hwnd" => {
            // A bare pointer type: model as void* (size handled by caller as pointer).
            return Some(TypeRefData {
                name: "void *".to_string(),
                size: 8,
                class: TypeClassData::Pointer {
                    pointee: Box::new(TypeRefData {
                        name: "void".to_string(),
                        size: 0,
                        class: TypeClassData::Void,
                    }),
                },
            });
        }
        _ => return None,
    };
    Some(TypeRefData {
        name: name.to_string(),
        size,
        class,
    })
}

/// Wrap a leaf ref per the parsed pointer/array modifiers.
fn apply_modifiers(base_ref: TypeRefData, parsed: &ParsedTypeExpr) -> TypeRefData {
    let mut r = base_ref;
    if parsed.pointer {
        r = TypeRefData {
            name: format!("{} *", r.name),
            size: 8,
            class: TypeClassData::Pointer {
                pointee: Box::new(r),
            },
        };
    }
    if let Some(count) = parsed.array_count {
        let elem = r;
        r = TypeRefData {
            name: format!("{}[{}]", elem.name, count),
            size: elem.size.saturating_mul(count),
            class: TypeClassData::Array {
                element: Box::new(elem),
                count,
            },
        };
    }
    r
}

/// A named-type lookup result: the ref plus, for PDB types, the module base needed
/// to expand the nested type by index.
#[derive(Clone)]
pub struct ResolvedNamed {
    pub type_ref: TypeRefData,
    pub module_base: Option<String>,
}

/// Resolve one field's type expression into a `(TypeRefData, module_base)`. Primitive
/// aliases resolve locally; other names are looked up via `resolve_named` (PDB/custom).
/// Unresolved names become an opaque `Unknown` ref (size 0). The returned module_base
/// is set only when a bare (non-pointer, non-array) PDB type is referenced.
fn resolve_field_ref(
    expr: &str,
    resolve_named: &mut dyn FnMut(&str) -> Option<ResolvedNamed>,
) -> (TypeRefData, Option<String>) {
    let parsed = parse_type_expr(expr);
    if let Some(base) = primitive_ref(&parsed.base) {
        return (apply_modifiers(base, &parsed), None);
    }
    match resolve_named(&parsed.base) {
        Some(named) => {
            // module_base only aids expansion of a directly-referenced UDT; once
            // wrapped in a pointer/array the member isn't index-expandable anyway.
            let module_base = if parsed.pointer || parsed.array_count.is_some() {
                None
            } else {
                named.module_base
            };
            (apply_modifiers(named.type_ref, &parsed), module_base)
        }
        None => (
            apply_modifiers(
                TypeRefData {
                    name: parsed.base.clone(),
                    size: 0,
                    class: TypeClassData::Unknown,
                },
                &parsed,
            ),
            None,
        ),
    }
}

/// Natural alignment for offset packing: pointers/large scalars → 8, clamped to the
/// member size, min 1.
fn field_alignment(r: &TypeRefData) -> u32 {
    let base_size = match &r.class {
        TypeClassData::Array { element, .. } => element.size,
        TypeClassData::Pointer { .. } => 8,
        _ => r.size,
    };
    base_size.clamp(1, 8).max(1)
}

fn align_up(offset: u32, align: u32) -> u32 {
    if align <= 1 {
        return offset;
    }
    offset.div_ceil(align) * align
}

/// Resolve a custom type definition into a full `TypeLayoutData` (source = "custom").
/// `resolve_named` resolves referenced non-primitive type names (PDB/custom).
pub fn resolve_custom_type(
    def: &CustomTypeDef,
    resolve_named: &mut dyn FnMut(&str) -> Option<ResolvedNamed>,
) -> TypeLayoutData {
    let mut members: Vec<TypeMemberData> = Vec::new();
    let mut cursor: u32 = 0;
    let mut max_align: u32 = 1;

    for field in &def.fields {
        let (type_ref, module_base) = resolve_field_ref(&field.type_expr, resolve_named);
        let align = field_alignment(&type_ref);
        max_align = max_align.max(align);

        let offset = if let Some(explicit) = field.offset {
            explicit
        } else if def.is_union {
            0
        } else {
            align_up(cursor, align)
        };

        let end = offset.saturating_add(type_ref.size);
        if def.is_union {
            cursor = cursor.max(type_ref.size);
        } else {
            cursor = end;
        }

        members.push(TypeMemberData {
            name: field.name.clone(),
            offset,
            type_ref,
            bit_position: None,
            bit_length: None,
            module_base,
        });
    }

    let computed = align_up(cursor, max_align);
    let size = def.size.unwrap_or(computed);

    TypeLayoutData {
        name: def.name.clone(),
        size,
        kind: if def.is_union { "union" } else { "struct" }.to_string(),
        index: 0,
        module_base: "0x0".to_string(),
        members,
        enum_values: Vec::new(),
        source: "custom".to_string(),
    }
}

// -------------------------------------------------------------------------
// C-like struct text parser
// -------------------------------------------------------------------------

/// Strip `//` line comments and `/* */` block comments.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// Parse a C-like struct/union declaration into a `CustomTypeDef`.
/// Accepts an optional `typedef`/`struct`/`union` keyword, a name, and a `{ ... }`
/// body of `<type> <field>[N]?;` declarations. Field offsets are left auto (None).
pub fn parse_c_struct(text: &str) -> Result<CustomTypeDef, String> {
    let text = strip_comments(text);
    let text = text.trim();

    let open = text
        .find('{')
        .ok_or_else(|| "expected a '{' to open the struct body".to_string())?;
    let close = text
        .rfind('}')
        .ok_or_else(|| "expected a '}' to close the struct body".to_string())?;
    if close <= open {
        return Err("malformed braces".to_string());
    }

    let header = &text[..open];
    let is_union = header.split_whitespace().any(|w| w == "union");
    // Name = last identifier token in the header (skips typedef/struct/union keywords).
    let name = header
        .split_whitespace()
        .filter(|w| !matches!(*w, "typedef" | "struct" | "union" | "class"))
        .next_back()
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("could not determine the type name from the header".to_string());
    }

    let body = &text[open + 1..close];
    let mut fields = Vec::new();
    for raw in body.split(';') {
        let decl = raw.trim();
        if decl.is_empty() {
            continue;
        }
        let (type_expr, field_name) = parse_field_decl(decl)
            .ok_or_else(|| format!("could not parse field declaration: '{}'", decl))?;
        fields.push(CustomFieldDef {
            name: field_name,
            type_expr,
            offset: None,
            comment: None,
        });
    }

    Ok(CustomTypeDef {
        id: String::new(),
        name,
        fields,
        is_union,
        size: None,
        comment: None,
    })
}

/// Split one field declaration into (type_expr, field_name).
/// Handles `unsigned long x`, `void *Peb`, `wchar_t name[16]`, `_LIST_ENTRY Links`.
fn parse_field_decl(decl: &str) -> Option<(String, String)> {
    // Peel a trailing array off the whole decl and re-attach to the type expr.
    let mut work = decl.to_string();
    let mut array_suffix = String::new();
    if let Some(open) = work.find('[') {
        if let Some(rel_close) = work[open..].find(']') {
            array_suffix = work[open..open + rel_close + 1].to_string();
            work.replace_range(open..open + rel_close + 1, "");
        }
    }

    // Normalize `*` to be space-separated so tokenization is simple.
    let work = work.replace('*', " * ");
    let tokens: Vec<&str> = work.split_whitespace().collect();
    if tokens.len() < 2 {
        return None;
    }

    // The field name is the last token; everything before is the type.
    let field_name = tokens.last().unwrap().to_string();
    let mut type_tokens: Vec<&str> = tokens[..tokens.len() - 1].to_vec();

    // A `*` sits between type and name (`void * Peb`): keep it in the type expr.
    let has_ptr = type_tokens.contains(&"*");
    type_tokens.retain(|t| *t != "*");
    if type_tokens.is_empty() {
        return None;
    }

    let mut type_expr = type_tokens.join(" ");
    if has_ptr {
        type_expr.push_str(" *");
    }
    type_expr.push_str(&array_suffix);

    Some((type_expr, field_name))
}
