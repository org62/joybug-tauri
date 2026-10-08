/* A program whose signal is its own business (Unix only): it handles SIGUSR1
 * and raises it. Exits 10 when the handler ran, 11 when the signal never
 * arrived - which is what a debugger that stopped on it and dropped it
 * leaves behind. The argument only makes the launch command unique. */
#include <signal.h>

static volatile sig_atomic_t g_got_usr1 = 0;

static void on_usr1(int signo) {
    (void)signo;
    g_got_usr1 = 1;
}

int main(void) {
    signal(SIGUSR1, on_usr1);
    raise(SIGUSR1);
    return g_got_usr1 ? 10 : 11;
}
