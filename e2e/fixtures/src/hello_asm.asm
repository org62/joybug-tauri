; E2E fixture for source-level debugging of assembly.
; Built with `ml64 /Zi` so the PDB carries per-instruction line info. Note:
; ml64 emits line numbers but NO source-file checksum, so the source view shows
; no "source differs" warning for this file (checksum_kind = "none").
;
; One instruction per line means a source-line step is exactly one machine step,
; which is a useful sanity check for line stepping.

EXTERN Sleep:PROC
EXTERN ExitProcess:PROC

.code

; int asm_loop(void) — small counted loop; each line is its own instruction.
asm_loop PROC
    mov     eax, 0
    mov     ecx, 5
loop_top:
    add     eax, 3
    dec     ecx
    jnz     loop_top
    ret
asm_loop ENDP

main PROC
    sub     rsp, 28h          ; shadow space + 16-byte alignment for calls
    call    asm_loop
    mov     ecx, 600000       ; dwMilliseconds
    call    Sleep
    xor     ecx, ecx
    call    ExitProcess
    add     rsp, 28h
    ret
main ENDP

END
