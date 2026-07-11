// E2E fixture for source-level debugging.
// Built with `cl /Od /Zi` so the PDB carries full line tables and an MD5/SHA
// source checksum. Distinctive strings ("compute", "hello_c_marker") let the
// tests assert the source text shows up in the UI. The long Sleep keeps the
// process alive while Playwright drives the debugger.
#include <windows.h>
#include <stdio.h>

static int compute(int n)
{
    int acc = 0;
    for (int i = 1; i <= n; i++)
    {
        acc += i * 2;
        if (acc > 1000)
        {
            acc -= 100;
        }
    }
    return acc;
}

static int hello_c_marker(int seed)
{
    int result = compute(seed);
    printf("hello_c_marker result=%d\n", result);
    return result;
}

int main(void)
{
    int value = hello_c_marker(41);
    printf("main computed value=%d\n", value);
    fflush(stdout);
    // Stay alive so the debugger UI can be driven against a live process.
    Sleep(600000);
    return value & 0xff;
}
