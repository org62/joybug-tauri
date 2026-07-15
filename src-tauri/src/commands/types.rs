/// Data structures used only by command return types (not shared with session processing)

#[derive(serde::Serialize)]
pub struct ModuleData {
    pub name: String,
    pub base_address: String,
    pub size: u64,
    pub path: String,
}

#[derive(serde::Serialize)]
pub struct ThreadData {
    pub id: u32,
    pub status: String,
    pub start_address: String,
}

#[derive(serde::Serialize)]
pub struct ModuleSymbolStatusData {
    pub module_path: String,
    pub base_address: String,
    /// "loaded" | "loading" | "failed" | "not_requested"
    pub status: String,
    pub symbol_count: Option<usize>,
    pub error: Option<String>,
    pub pdb_path: Option<String>,
}

#[derive(serde::Serialize)]
pub struct PdbMismatchData {
    pub pe_guid: String,
    pub pe_age: u32,
    pub pdb_guid: String,
    pub pdb_age: u32,
}

#[derive(serde::Serialize)]
pub struct PdbLoadResultData {
    pub loaded: bool,
    pub symbol_count: Option<usize>,
    pub mismatch: Option<PdbMismatchData>,
}

// ---------------------------------------------------------------------------
// Type system (PDB TPI + user-defined) frontend DTOs.
//
// Mirror joybug2's `TypeLayout`/`TypeSummary`/`TypeRef`, but with 64-bit addresses
// as hex strings (JS number precision) and a `source` tag so PDB and custom types
// render through the same UI.
// ---------------------------------------------------------------------------

/// Broad value category of a type. Tagged enum: `{ kind: "pointer", pointee: {..} }`.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TypeClassData {
    Int,
    UInt,
    Float,
    Bool,
    Char,
    WChar,
    Void,
    Pointer { pointee: Box<TypeRefData> },
    Array { element: Box<TypeRefData>, count: u32 },
    Udt { index: u32 },
    Enum { index: u32 },
    Unknown,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TypeRefData {
    pub name: String,
    pub size: u32,
    pub class: TypeClassData,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TypeMemberData {
    pub name: String,
    pub offset: u32,
    pub type_ref: TypeRefData,
    pub bit_position: Option<u8>,
    pub bit_length: Option<u8>,
    /// Overrides the layout's `module_base` when expanding this member's nested UDT
    /// by index (used when a custom type references a PDB type in another module).
    /// `None` = inherit the containing layout's `module_base`.
    #[serde(default)]
    pub module_base: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TypeEnumValueData {
    pub name: String,
    pub value: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TypeLayoutData {
    pub name: String,
    pub size: u32,
    /// "struct" | "class" | "union" | "enum"
    pub kind: String,
    /// TPI index within the owning module's PDB (0 for custom types).
    pub index: u32,
    /// Base address (hex) of the module whose PDB defines this type ("0x0" for custom).
    pub module_base: String,
    pub members: Vec<TypeMemberData>,
    pub enum_values: Vec<TypeEnumValueData>,
    /// "pdb" | "custom"
    pub source: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TypeSummaryData {
    pub name: String,
    pub size: u32,
    pub kind: String,
    pub index: u32,
    pub module_base: String,
    pub module_name: String,
    pub source: String,
}

fn udt_kind_str(kind: joybug2::protocol_io::UdtKind) -> &'static str {
    use joybug2::protocol_io::UdtKind;
    match kind {
        UdtKind::Struct => "struct",
        UdtKind::Class => "class",
        UdtKind::Union => "union",
        UdtKind::Enum => "enum",
    }
}

impl From<joybug2::protocol_io::TypeClass> for TypeClassData {
    fn from(c: joybug2::protocol_io::TypeClass) -> Self {
        use joybug2::protocol_io::TypeClass;
        match c {
            TypeClass::Int => TypeClassData::Int,
            TypeClass::UInt => TypeClassData::UInt,
            TypeClass::Float => TypeClassData::Float,
            TypeClass::Bool => TypeClassData::Bool,
            TypeClass::Char => TypeClassData::Char,
            TypeClass::WChar => TypeClassData::WChar,
            TypeClass::Void => TypeClassData::Void,
            TypeClass::Pointer { pointee } => TypeClassData::Pointer {
                pointee: Box::new((*pointee).into()),
            },
            TypeClass::Array { element, count } => TypeClassData::Array {
                element: Box::new((*element).into()),
                count,
            },
            TypeClass::Udt { index } => TypeClassData::Udt { index },
            TypeClass::Enum { index } => TypeClassData::Enum { index },
            TypeClass::Unknown => TypeClassData::Unknown,
        }
    }
}

impl From<joybug2::protocol_io::TypeRef> for TypeRefData {
    fn from(r: joybug2::protocol_io::TypeRef) -> Self {
        TypeRefData {
            name: r.name,
            size: r.size,
            class: r.class.into(),
        }
    }
}

impl From<joybug2::protocol_io::TypeMember> for TypeMemberData {
    fn from(m: joybug2::protocol_io::TypeMember) -> Self {
        TypeMemberData {
            name: m.name,
            offset: m.offset,
            type_ref: m.type_ref.into(),
            bit_position: m.bit_position,
            bit_length: m.bit_length,
            // PDB members inherit the layout's module_base (same PDB).
            module_base: None,
        }
    }
}

impl From<joybug2::protocol_io::TypeLayout> for TypeLayoutData {
    fn from(l: joybug2::protocol_io::TypeLayout) -> Self {
        TypeLayoutData {
            name: l.name,
            size: l.size,
            kind: udt_kind_str(l.kind).to_string(),
            index: l.index,
            module_base: format!("0x{:X}", l.module_base),
            members: l.members.into_iter().map(Into::into).collect(),
            enum_values: l
                .enum_values
                .into_iter()
                .map(|v| TypeEnumValueData { name: v.name, value: v.value })
                .collect(),
            source: "pdb".to_string(),
        }
    }
}

impl From<joybug2::protocol_io::TypeSummary> for TypeSummaryData {
    fn from(s: joybug2::protocol_io::TypeSummary) -> Self {
        TypeSummaryData {
            name: s.name,
            size: s.size,
            kind: udt_kind_str(s.kind).to_string(),
            index: s.index,
            module_base: format!("0x{:X}", s.module_base),
            module_name: s.module_name,
            source: "pdb".to_string(),
        }
    }
}
