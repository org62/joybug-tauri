// E2E fixture for exception reporting.
// Built with `cl /Od /Zi` so the PDB names `crash_here`. After the process's
// initial debugger pause it writes to a fixed unmapped address, raising a
// first-chance EXCEPTION_ACCESS_VIOLATION whose record the tests assert on:
// access kind "write", referenced address 0xDEAD0000, faulting symbol
// `crash_c!crash_here`, and a callstack that includes it. The address is in
// user space so a 32-bit build faults the same way. Nothing follows the fault:
// the program has no handler, so continuing "handled" re-runs the faulting
// store and passing it through kills the process on the second chance. Either
// way `main` never resumes, so there is nothing for it to do.
#include <windows.h>   // UINT_PTR

__declspec(noinline) void crash_here(void)
{
    volatile int *bad = (volatile int *)(UINT_PTR)0xDEAD0000;
    *bad = 42; /* write access violation */
}

int main(void)
{
    crash_here();
    return 0;
}
