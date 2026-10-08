// E2E fixture to attach to: stays alive for the whole test. The Windows specs
// spawn `ping` for this; its Linux counterpart must also opt in to being traced
// by a non-ancestor — with Yama `ptrace_scope=1` (the Ubuntu default) only a
// descendant may be attached to otherwise, and the debugger here is a sibling.
#include "portable.h"
#ifndef _WIN32
#include <sys/prctl.h>
#endif

int main(void)
{
#ifndef _WIN32
    prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY, 0, 0, 0);
#endif
    for (int i = 0; i < 999; i++)
        sleep_ms(1000);
    return 0;
}
