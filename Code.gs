// TD Survivor — Google Apps Script backend starter.
// Create a Google Sheet, open Extensions > Apps Script, paste this file,
// and deploy as a Web App. The production PWA will call these endpoints.
//
// SHEETS:
// Participants: id | name | phone/email | paid | status | buyback_used
// Picks: week | participant_id | player_id | player_name | result | submitted_at
// Players: player_id | name | team | position | active
// Settings: key | value
//
// This starter intentionally does not include authentication or live NFL
// scoring yet. Those are the next production steps.

const SS_ID = 'PASTE_GOOGLE_SHEET_ID_HERE';

function sheet_(name) {
  return SpreadsheetApp.openById(SS_ID).getSheetByName(name);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'state';
  if (action === 'state') return json_(getState_());
  return json_({ok:false,error:'Unknown action'});
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  if (body.action === 'submitPick') return json_(submitPick_(body));
  if (body.action === 'lockWeek') return json_(lockWeek_(body));
  if (body.action === 'buyback') return json_(buyback_(body));
  return json_({ok:false,error:'Unknown action'});
}

function getState_() {
  return {ok:true, message:'Backend starter is connected.', timestamp:new Date().toISOString()};
}

function submitPick_(b) {
  // Production implementation: validate participant, week, lock state,
  // player availability, duplicate player use, then append to Picks.
  return {ok:true, message:'submitPick endpoint ready for implementation.'};
}

function lockWeek_(b) {
  return {ok:true, message:'lockWeek endpoint ready for implementation.'};
}

function buyback_(b) {
  return {ok:true, message:'buyback endpoint ready for implementation.'};
}
