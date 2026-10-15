// The delay models the app knows about, and what each one needs before it is offered.
//
// A model is a declarative entry: an id, the times mode that runs it (null: not built yet), what it is and how much
// data it needs. Whether it is worth using is not decided here: data/model-report.json (written by
// scripts/evaluate.py) scores every available model on a day that no calibration saw, and a model is only
// recommended when it beats the baseline there.
const MODEL_REGISTRY = [
  {
    id: 'raw', mode: 'raw', role: 'baseline', label: 'Raw',
    summary: 'The announced delay, held unchanged on every following stop.', needsDays: 0
  },
  {
    id: 'rules-v2', mode: 'model', role: 'model', label: 'Recovery rules',
    summary: 'Delay recovered on the way, from the last real departure; a stop lasts longer than the timetable says.', needsDays: 2
  },
  {
    id: 'tables', mode: null, role: 'model', label: 'Line, hour and day tables',
    summary: 'Typical delays by line, time of day and weekday.', needsDays: 7
  },
  {
    id: 'trees', mode: null, role: 'model', label: 'Trees, with the train ahead',
    summary: 'Learned from many features, among them the delay of the train just ahead on the line.', needsDays: 14
  }
]

// "active": the one the pages use now; "available": built and scored; "collecting": waiting for days of data;
// "to build": enough days, but no implementation yet.
function modelStatus(model, report, activeMode) {
  if (model.mode) return model.mode === activeMode ? 'active' : 'available'
  const have = report && report.readiness && report.readiness[model.id] ? report.readiness[model.id].have_days : 0
  return have >= model.needsDays ? 'to build' : 'collecting'
}

function daysAvailable(report) {
  return report && report.split ? report.split.calibration_days.length + (report.split.test_day ? 1 : 0) : 0
}

// "Beats the baseline on the held-out day": the only way a model gets recommended.
function beatsBaseline(model, report) {
  const scores = report && report.models
  if (!scores || !scores[model.id] || !scores.raw) return false
  return model.id !== 'raw' && scores[model.id].mae_1_to_6 < scores.raw.mae_1_to_6
}

if (typeof module !== 'undefined') {
  module.exports = { MODEL_REGISTRY, modelStatus, daysAvailable, beatsBaseline }
}
