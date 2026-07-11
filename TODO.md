# TODO

- [ ] Avoid scanning unchanged result rows when publishing a new revision to
  unrelated query roots; benchmark large roots as well as many roots.
- [ ] Extend indexed reference joins from singleton key tuples to composite key
  tuples. The current fallback is correct, but rematerializes more work.
- [ ] Define when a rejected relation update can invalidate only dependent roots
  without hiding uncertainty from shared basis or membership evidence.
