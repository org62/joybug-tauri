// E2E fixture standing in for `cmd.exe /c echo ...` off Windows: prints its
// arguments and exits 0. The Windows specs launch cmd.exe because every machine
// has it and its ntdll/kernel32 come with full symbols; a Linux system binary is
// stripped, so this fixture (built with `cc -g`) is the symbolised default
// target instead — `echo_c!main`, DWARF lines, libc/ld.so loaded by the time
// the initial breakpoint (the entry point) is reached.
#include "portable.h"

// Specs navigate the disassembly to `pc + 0x2000` from the initial breakpoint
// and expect decodable code there (on Windows that is still inside ntdll).
// Keep enough .text after `_start` for that: 0x3000 bytes of nop.
NOINLINE void e2e_text_padding(void)
{
#ifdef _WIN32
    volatile int unused = 0; /* MSVC has no .fill; the Windows specs stay in ntdll */
    (void)unused;
#else
    __asm__ volatile(".fill 0x3000, 1, 0x90");
#endif
}

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++)
        printf("%s%s", i > 1 ? " " : "", argv[i]);
    printf("\n");
    fflush(stdout);
    if (argc > 100) e2e_text_padding();
    return 0;
}
