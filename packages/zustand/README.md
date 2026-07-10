# @tarstate/zustand

The official thin Zustand adapter for Tarstate's generic atomic external-store
protocol.

Adapted stores must contain plain data state. Tarstate replacements use
Zustand's replace mode, so action functions should remain outside the adapted
state object.
