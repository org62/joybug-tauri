// The stripped image keeps only the exported entry. Both private callees
// appear in the separate PDB/unstripped ELF and run on every released call.
#include "portable.h"

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

static NOINLINE int deferred_private_removed(int value)
{
    return value + 1;
}

static NOINLINE int deferred_private(int value)
{
    return value * 2;
}

EXPORT NOINLINE int deferred_exported(void)
{
    return deferred_private(deferred_private_removed(20));
}
