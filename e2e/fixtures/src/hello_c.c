// E2E fixture for source-level debugging.
// Built with `cl /Od /Zi` (PDB) on Windows and `cc -g -O0` (DWARF) on Linux,
// so the line tables carry a source checksum where the toolchain emits one. Distinctive strings ("compute", "hello_c_marker") let the
// tests assert the source text shows up in the UI. The trailing sleep keeps
// the process alive while Playwright drives the debugger -- see main().
#include "portable.h"
#include <string.h>

/* Types for the Types-view spec: the same layouts come out of the PDB (MSVC)
 * and the DWARF (gcc), so one assertion covers both. */
enum Color { RED = 0, GREEN = 1, BLUE = 2 };
struct Point { int x; int y; };
struct Shape {
    struct Point origin;
    unsigned flags : 3;
    unsigned filled : 1;
    enum Color color;
    const char *name;
    double scale[4];
};
union Word { unsigned int u; float f; };
volatile struct Shape g_shape = { { 1, 2 }, 5, 1, BLUE, "shape", { 1.0, 2.0, 3.0, 4.0 } };
volatile union Word g_word = { 7 };

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

// A second thread parked in a long sleep, so the thread specs have a thread
// that is neither the main thread nor the one the break-in lands on. (On
// Windows the break-in injects its own thread as well.)
#ifdef _WIN32
typedef HRESULT (WINAPI *SetThreadDescriptionFn)(HANDLE, PCWSTR);

static void legacy_thread_name(const char *name)
{
    ULONG_PTR fields[4];
    DWORD count;
#ifdef _WIN64
    /* The native record occupies three slots, including deliberately nonzero padding. */
    fields[0] = ((ULONG_PTR)0xA5A5A5A5 << 32) | 0x1000;
    fields[1] = (ULONG_PTR)name;
    fields[2] = 0xFFFFFFFF;
    count = 3;
#else
    fields[0] = 0x1000;
    fields[1] = (ULONG_PTR)name;
    fields[2] = 0xFFFFFFFF;
    fields[3] = 0;
    count = 4;
#endif
    __try {
        RaiseException(0x406D1388, 0, count, fields);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        /* Allows the same opt-in target to run without a debugger. */
    }
}

struct diagnostic_worker_args {
    HANDLE ready;
    HANDLE release;
    int modern;
};

static SetThreadDescriptionFn describe_thread;

NOINLINE void thread_info_ready_marker(void)
{
    /* A call-free marker for manual/native/WOW64 inspection. */
    volatile int ready = 1;
    (void)ready;
}

static DWORD WINAPI diagnostic_worker(LPVOID arg)
{
    struct diagnostic_worker_args *args = (struct diagnostic_worker_args *)arg;
    legacy_thread_name(args->modern ? "Worker legacy fallback" : "Legacy worker");
    if (args->modern && describe_thread)
        describe_thread(GetCurrentThread(), L"Worker \x03A9 diagnostic");
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    SetEvent(args->ready);
    SetLastError(0x12345678);
    thread_info_ready_marker();
    WaitForSingleObject(args->release, INFINITE);
    return 0;
}

static int run_thread_information_mode(void)
{
    struct diagnostic_worker_args args[2];
    HANDLE workers[2];
    HANDLE release = CreateEventW(NULL, TRUE, FALSE, NULL);
    describe_thread = (SetThreadDescriptionFn)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "SetThreadDescription");
    if (!release || !describe_thread) return 90;
    legacy_thread_name("Main legacy fallback");
    describe_thread(GetCurrentThread(), L"Main \x0394 thread");
    for (int i = 0; i < 2; ++i) {
        args[i].ready = CreateEventW(NULL, TRUE, FALSE, NULL);
        args[i].release = release;
        args[i].modern = i == 0;
        if (!args[i].ready) return 91;
        workers[i] = CreateThread(NULL, 0, diagnostic_worker, &args[i], 0, NULL);
        if (!workers[i]) return 92;
    }
    WaitForSingleObject(args[0].ready, INFINITE);
    WaitForSingleObject(args[1].ready, INFINITE);
    SetLastError(0x87654321);
    thread_info_ready_marker();
    /* All names are now published. Named-mode lifetime is controlled by the debugger. */
    WaitForSingleObject(release, INFINITE);
    for (int i = 0; i < 2; ++i) {
        WaitForSingleObject(workers[i], INFINITE);
        CloseHandle(workers[i]);
        CloseHandle(args[i].ready);
    }
    CloseHandle(release);
    return 0;
}

static DWORD WINAPI parked_worker(LPVOID arg)
{
    (void)arg;
    sleep_ms(60000);
    return 0;
}
static void start_parked_worker(void)
{
    CreateThread(NULL, 0, parked_worker, NULL, 0, NULL);
}
#else
#include <pthread.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sched.h>
static void *parked_worker(void *arg)
{
    (void)arg;
    // A raw pause syscall, not a sleep: a thread switch has to land on a
    // *different* PC than the thread it switched from, and since glibc 2.40
    // every cancellable blocking call (nanosleep, pause, ...) parks in the one
    // shared __syscall_cancel_arch. syscall() has its own instruction.
    syscall(SYS_pause);
    return NULL;
}
static void start_parked_worker(void)
{
    pthread_t t;
    pthread_create(&t, NULL, parked_worker, NULL);
}
#endif

// Windows: a plain Sleep — the break-in lands on a thread the debugger
// injects, so main can block. Linux: the break-in stops main itself, and a
// step from inside a blocking syscall only completes when that syscall
// returns, so main has to stay steppable: it yields in a loop instead.
static void stay_alive(unsigned ms)
{
#ifdef _WIN32
    sleep_ms(ms);
#else
    struct timespec start, now;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;)
    {
        clock_gettime(CLOCK_MONOTONIC, &now);
        if ((now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000 >= (long)ms)
            break;
        sched_yield();
    }
#endif
}

int main(int argc, char **argv)
{
#ifdef _WIN32
    if (argc > 1 && strcmp(argv[1], "--thread-info") == 0)
        return run_thread_information_mode();
#else
    (void)argc;
    (void)argv;
#endif
    start_parked_worker();
    int value = hello_c_marker(41);
    printf("main computed value=%d\n", value);
    fflush(stdout);
    // Stay alive so the debugger UI can be driven against a live process
    // (thread-control and thread-switch resume this target and break back into
    // it seconds later). Long enough for any spec's resume window, short
    // enough that a stray fixture or a manual Go doesn't look like a hang.
    stay_alive(60000);
    return value & 0xff;
}
