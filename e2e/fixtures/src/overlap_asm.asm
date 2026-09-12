; E2E fixture for disassembling OVERLAPPING code: an instruction that lives
; inside another instruction's immediate operand.
;
; Built with `ml64 /Zi` + `link /DEBUG` (see build.mjs) so the PDB carries public
; symbols and the image carries a .pdata RUNTIME_FUNCTION for overlap_fn.
;
; The .pdata entry is the whole point. "Disassemble the function containing X"
; re-anchors its decode to the function start whenever bounds are known, and a
; mid-instruction X still satisfies `start <= X < end` — so the aligned listing
; never contains the hidden instruction, and a goto to it used to do nothing.
;
; This fixture is only ever inspected, never run or stepped: it is x64-pinned, so
; on an ARM64 host it would execute emulated (see the arch note in build.mjs).

EXTERN ExitProcess:PROC

.code

; The bytes below assemble by hand rather than as `mov rax, <literal>` so the
; encoding is byte-exact instead of at the assembler's discretion:
;
;   overlap_fn+1:  48 B8 0F 31 C3 90 90 90 90 90   movabs rax, 9090909090C3310Fh
;   overlap_fn+3:        0F 31                     rdtsc     <- hidden
;                              C3                  ret
;
; `rdtsc` appears nowhere else in this image, so a listing containing it can only
; have come from decoding at the unaligned address.
overlap_fn PROC FRAME
    push    rbp
    .pushreg rbp
    .endprolog
    DB      48h, 0B8h                   ; movabs rax, <imm64>
    DB      0Fh, 31h                    ; imm64 byte 0-1: rdtsc
    DB      0C3h                        ; imm64 byte 2:   ret
    DB      90h, 90h, 90h, 90h, 90h     ; imm64 byte 3-7: nop padding
    pop     rbp
    ret
overlap_fn ENDP

; No keep-alive sleep: the fixture is inspected while parked at the initial
; breakpoint and never resumed. Resuming it just exits.
main PROC
    sub     rsp, 28h          ; shadow space + 16-byte alignment for calls
    call    overlap_fn        ; keeps overlap_fn referenced; harmless to run
    xor     ecx, ecx
    call    ExitProcess
    add     rsp, 28h
    ret
main ENDP

END
