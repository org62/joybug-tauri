import React, { useContext } from "react";
import type { ElfInfo, ModuleExtraInfo } from "@/hooks/useModuleInfo";
import { hex, hexBig } from "@/lib/peDecode";
import {
  DT_ADDRESS_TAGS, DT_VALUES, ELF_CLASS_VALUES, ELF_DATA_VALUES, ELF_MACHINE_VALUES, ELF_OSABI_VALUES,
  ELF_TYPE_VALUES, PF_FLAGS, PT_VALUES, SHF_FLAGS, SHT_VALUES, decodePFlags, elfEnumLabel,
} from "@/lib/elfDecode";
import {
  Addr, ExceptionGroup, ExportsGroup, FlagsEditor, GroupRow, ImportsGroup, LeafRow,
} from "@/components/pe/structureTree";

/**
 * The structure tree of an ELF module, read-only (header edits are PE-only):
 * the ELF header, program headers, section headers, `.dynamic` and the
 * identity notes, followed by the collections both formats share — the
 * GOT slots as imports, the dynamic symbols as exports and the `.eh_frame`
 * function table. Rendered inside `PeStructureTree`'s contexts.
 */
export const ElfStructureTree: React.FC<{
  info: ModuleExtraInfo;
  elf: ElfInfo;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}> = ({ info, elf, scrollRef }) => {
  const h = elf.header;
  return (
    <ElfMinVaddrContext.Provider value={elf.min_vaddr}>
      <GroupRow id="elf" label="ELF Header" depth={0}>
        <LeafRow label="Class" depth={1}><Enum values={ELF_CLASS_VALUES} value={h.class} /></LeafRow>
        <LeafRow label="Data" depth={1}><Enum values={ELF_DATA_VALUES} value={h.data} /></LeafRow>
        <LeafRow label="OS/ABI" depth={1}><Enum values={ELF_OSABI_VALUES} value={h.os_abi} /></LeafRow>
        <LeafRow label="ABI Version" depth={1}>{h.abi_version}</LeafRow>
        <LeafRow label="Type" depth={1}><Enum values={ELF_TYPE_VALUES} value={h.e_type} /></LeafRow>
        <LeafRow label="Machine" depth={1}><Enum values={ELF_MACHINE_VALUES} value={h.e_machine} /></LeafRow>
        <LeafRow label="Version" depth={1}>{hex(h.e_version)}</LeafRow>
        <LeafRow label="Entry point address" depth={1}><Va va={h.e_entry} /></LeafRow>
        <LeafRow label="Start of program headers" depth={1}>{hex(h.e_phoff)} <Count n={h.e_phnum} what="entries" /> <Count n={h.e_phentsize} what="bytes each" /></LeafRow>
        <LeafRow label="Start of section headers" depth={1}>{hex(h.e_shoff)} <Count n={h.e_shnum} what="entries" /> <Count n={h.e_shentsize} what="bytes each" /></LeafRow>
        <LeafRow label="Flags" depth={1}>{hex(h.e_flags)}</LeafRow>
        <LeafRow label="Size of this header" depth={1}>{h.e_ehsize}</LeafRow>
        <LeafRow label="Section header string table index" depth={1}>{h.e_shstrndx}</LeafRow>
        {elf.interp && <LeafRow label="Interpreter" depth={1}>{elf.interp}</LeafRow>}
        {elf.soname && <LeafRow label="SONAME" depth={1}>{elf.soname}</LeafRow>}
        {elf.build_id && <LeafRow label="Build ID" depth={1}>{elf.build_id}</LeafRow>}
        {elf.debuglink && <LeafRow label="Debug link" depth={1}>{elf.debuglink}</LeafRow>}
      </GroupRow>

      <GroupRow id="phdrs" label="Program Headers" depth={0} count={elf.program_headers.length}>
        {elf.program_headers.map((p, i) => (
          <GroupRow
            key={i}
            id={`phdr.${i}`}
            depth={1}
            label={<span>{elfEnumLabel(PT_VALUES, p.p_type)} <span className="font-mono text-muted-foreground font-normal">{decodePFlags(p.p_flags)} {hexBig(p.p_vaddr)}</span></span>}
          >
            <LeafRow label="Type" depth={2}><Enum values={PT_VALUES} value={p.p_type} /></LeafRow>
            <FlagsEditor id={`phdr.${i}.flags`} label="Flags" depth={2} value={p.p_flags} flags={PF_FLAGS} />
            <LeafRow label="Offset" depth={2}>{hex(p.p_offset)}</LeafRow>
            <LeafRow label="VirtAddr" depth={2}><Va va={p.p_vaddr} /></LeafRow>
            <LeafRow label="PhysAddr" depth={2}>{hexBig(p.p_paddr)}</LeafRow>
            <LeafRow label="FileSiz" depth={2}>{hex(p.p_filesz)}</LeafRow>
            <LeafRow label="MemSiz" depth={2}>{hex(p.p_memsz)}</LeafRow>
            <LeafRow label="Align" depth={2}>{hex(p.p_align)}</LeafRow>
          </GroupRow>
        ))}
      </GroupRow>

      <GroupRow id="sections" label="Sections" depth={0} count={elf.sections.length}>
        {elf.sections.map((s, i) => (
          <GroupRow
            key={i}
            id={`sec.${i}`}
            depth={1}
            label={<span>{s.name || `#${i}`} <span className="font-mono text-muted-foreground font-normal">{elfEnumLabel(SHT_VALUES, s.sh_type)}</span></span>}
          >
            <LeafRow label="Type" depth={2}><Enum values={SHT_VALUES} value={s.sh_type} /></LeafRow>
            <FlagsEditor id={`sec.${i}.flags`} label="Flags" depth={2} value={s.sh_flags} flags={SHF_FLAGS} />
            <LeafRow label="Address" depth={2}>{s.sh_flags & 0x2 ? <Va va={s.sh_addr} /> : hexBig(s.sh_addr)}</LeafRow>
            <LeafRow label="Offset" depth={2}>{hex(s.sh_offset)}</LeafRow>
            <LeafRow label="Size" depth={2}>{hex(s.sh_size)}</LeafRow>
            <LeafRow label="Link" depth={2}>{s.sh_link}</LeafRow>
            <LeafRow label="Info" depth={2}>{s.sh_info}</LeafRow>
            <LeafRow label="Align" depth={2}>{hex(s.sh_addralign)}</LeafRow>
            <LeafRow label="EntSize" depth={2}>{hex(s.sh_entsize)}</LeafRow>
          </GroupRow>
        ))}
      </GroupRow>

      {elf.dynamic.length > 0 && (
        <GroupRow id="dynamic" label="Dynamic Section" depth={0} count={elf.dynamic.length}>
          {elf.dynamic.map((d, i) => (
            <LeafRow key={i} label={elfEnumLabel(DT_VALUES, d.tag)} depth={1}>
              {d.string != null ? (
                <span>{d.string} <span className="text-muted-foreground">({hex(d.value)})</span></span>
              ) : DT_ADDRESS_TAGS.has(d.tag) && d.value !== 0 ? (
                <Va va={d.value} />
              ) : (
                hexBig(d.value)
              )}
            </LeafRow>
          ))}
        </GroupRow>
      )}

      <ImportsGroup info={info} scrollRef={scrollRef} label="Imports (GOT)" />
      <ExportsGroup info={info} scrollRef={scrollRef} label="Dynamic symbols" />
      <ExceptionGroup info={info} scrollRef={scrollRef} label="Functions (.eh_frame)" />
    </ElfMinVaddrContext.Provider>
  );
};

// "NAME (0xNN)", the read-only spelling of an enum field.
const Enum: React.FC<{ values: { value: number; label: string }[]; value: number }> = ({ values, value }) => (
  <>{elfEnumLabel(values, value)} <span className="text-muted-foreground">(0x{value.toString(16)})</span></>
);

const Count: React.FC<{ n: number; what: string }> = ({ n, what }) => (
  <span className="text-muted-foreground">· {n} {what}</span>
);

// A link-time VA as an address link: the mapping and the links work in RVAs
// (`va - min_vaddr`). Zero, or a value below the image base (not an
// address), is shown as a plain number.
const Va: React.FC<{ va: number }> = ({ va }) => {
  const min = useContext(ElfMinVaddrContext);
  if (va === 0 || va < min) return <>{hexBig(va)}</>;
  return <Addr rva={va - min} />;
};

/** The image's link-time base, for `Va`. */
const ElfMinVaddrContext = React.createContext<number>(0);
