from synchronicity import Synchronizer

# One synchronizer for the whole package. Wrapping every public class with the
# same instance lets synchronicity translate impl objects returned across the
# boundary (e.g. _Disks.get returning a _Disk) into their blocking wrappers, and
# keeps a single background event loop for all async work.
synchronizer = Synchronizer()


def translate_out(obj):
    """Convert an impl instance to its public (blocking/.aio) wrapper.

    synchronicity auto-translates impl objects returned directly from a method or
    nested in a list/dict/tuple, but NOT those nested inside a dataclass. Disks
    must hand a wrapped Disk back inside the CreateDiskResult dataclass, so it
    translates explicitly. ``test_create_disk`` guards that the result's ``disk``
    is a blocking wrapper, so a synchronicity change here fails loudly."""
    return synchronizer._translate_out(obj)


def translate_in(obj):
    """Convert a public (blocking) wrapper to its impl instance; an impl (or any
    non-wrapper) passes through unchanged. The mirror of :func:`translate_out`.

    A wrapped class holding other wrapped objects must store the *impl* form so
    its async methods can await them directly on the shared loop. synchronicity
    auto-translates method arguments, but not those nested inside a dataclass
    (e.g. ``ExecMountSpec.disk``), so ``Workspace`` normalizes explicitly."""
    return synchronizer._translate_in(obj)
