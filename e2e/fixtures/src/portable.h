// Shared shims so one fixture source builds with MSVC (cl) and with cc.
// The E2E suite runs the same specs on Windows and Linux; the fixtures are the
// debuggees, so they must compile — and behave the same — on both.
#ifndef JOYBUG_E2E_PORTABLE_H
#define JOYBUG_E2E_PORTABLE_H

#include <stdio.h>

#ifdef _WIN32
#include <windows.h>
#define NOINLINE __declspec(noinline)
static void sleep_ms(unsigned ms) { Sleep(ms); }
typedef UINT_PTR uptr_t;
#else
#include <stdint.h>
#include <time.h>
#define NOINLINE __attribute__((noinline))
static void sleep_ms(unsigned ms)
{
    struct timespec ts = { (time_t)(ms / 1000), (long)(ms % 1000) * 1000000L };
    while (nanosleep(&ts, &ts) != 0) { /* resume after a debugger-induced EINTR */ }
}
typedef uintptr_t uptr_t;
#endif

#endif
