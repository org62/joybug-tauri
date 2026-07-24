// E2E fixture for the hardware access trace ("find what reads/writes an address").
// A volatile global is read and written in a tight loop that runs AFTER the
// process's initial debugger pause, so a watchpoint armed at that pause reliably
// collects the accessing instructions. Built with `cl /Od /Zi` for a full PDB so
// the test can resolve `g_watch_target` by symbol. The long Sleep keeps the
// process alive while Playwright polls the collected accessors.
#include <windows.h>
#include <stdio.h>

volatile unsigned int g_watch_target = 0;

__declspec(noinline) void access_loop(void)
{
    for (unsigned int i = 0; i < 64; i++)
    {
        g_watch_target = i;                        /* write access */
        volatile unsigned int v = g_watch_target;  /* read access  */
        (void)v;
    }
}

int main(void)
{
    access_loop();
    printf("watch_c_marker g=%u\n", g_watch_target);
    fflush(stdout);
    // Stay alive so the debugger UI can poll collected accessors.
    Sleep(600000);
    return 0;
}
