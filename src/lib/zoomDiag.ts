// What the last chart rebuild did with the saved zoom, surfaced in App
// Diagnostics. Its own module rather than an export from AdvancedChart, because
// AdvancedChart already imports DiagnosticsPanel — importing back would be a
// cycle, and a cycle here means an undefined binding at module init, which is a
// blank screen.
export const zoomDiag = {
  rebuilds: 0,
  decision: 'none',
  saved: '',
  applied: '',
  reason: '',
  at: 0,
};
