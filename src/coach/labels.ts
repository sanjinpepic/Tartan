/**
 * The coach's steps in words for the chat ("Checking how ready you are").
 */


export const TOOL_LABELS: Record<string, string> = {
  get_overview: "Looking at your data",
  get_goals: "Checking your targets",
  get_milestones: "Looking at what you've earned",
  get_takeaways: "Checking your takeaways",
  list_activities: "Reading your activities",
  get_activity: "Opening a workout",
  get_activity_streams: "Reading heart rate and pace",
  get_training_summary: "Adding up your weeks",
  get_training_load: "Checking fitness and fatigue",
  get_hr_zones: "Counting time in zones",
  get_efficiency_trend: "Checking efficiency",
  get_durability: "Checking how your long runs hold",
  get_weather: "Checking the forecast",
  get_best_efforts: "Looking up your bests",
  get_athlete_profile: "Reading your profile",
  list_watch_files: "Listing watch files",
  read_watch_file: "Reading a watch file",
  get_training_plan: "Reading your plan",
  review_session: "Checking how a session went",
  get_readiness: "Checking how ready you are",
  get_health: "Looking at your heart rate, sleep and oxygen",
  get_body_signals: "Looking at your sleep and recovery",
  note_body_signals: "Noting how you are",
  get_body: "Checking your muscles",
  get_lifts: "Looking at your lifts",
  get_week: "Looking at the week",
  save_training_plan: "Writing your plan",
  mark_plan_session: "Ticking off a session",
  swap_plan_session: "Changing today's session",
  get_habits: "Looking at what suits you",
  log_workout: "Logging your workout",
  remove_logged_workout: "Taking back a logged workout",
  set_training_availability: "Noting your time",
  get_training_times: "Checking your training times",
  set_training_times: "Setting your training times",
  export_training_plan_csv: "Exporting the plan",
  edit_session: "Changing the session",
  get_run_notes: "Reading your run notes",
  get_shoes: "Checking your shoes",
  get_memory: "Going over what you've told me",
  remember: "Noting that down",
  update_memory: "Updating my notes",
  forget_memory: "Forgetting that",
  export_training_plan_ics: "Making a calendar file",
  list_routes: "Looking through your routes",
  get_route: "Opening a route",
  make_route: "Finding a route (about a minute)",
  route_from_run: "Tracing one of your runs",
  show_route: "Bringing up the route",
  save_route: "Saving the route",
  reset_training_plan: "Clearing the plan",
  list_watch_faces: "Looking at your watch faces",
  save_watch_face: "Saving the watch face",
  sync_strava: "Bringing in Strava",
  busy: "Google was busy: asked again",
  change_plan: "Handing the plan to your planner",
};

/**
 * A step the coach takes, in words for the chat ("Checking how ready you are"). A tool without a
 * label of its own still reads as words, never as its code name ("get_x_y" → "Checking x y").
 */
export function toolLabel(name: string): string {
  const own = TOOL_LABELS[name];
  if (own) return own;
  const [verb, ...rest] = name.split("_");
  const what = rest.join(" ").replace(/\btraining\b ?/, "").trim();
  const lead: Record<string, string> = { get: "Checking", list: "Looking through", set: "Setting", save: "Saving", make: "Making", send: "Sending", sync: "Bringing in", mark: "Marking", export: "Exporting", review: "Going over", show: "Bringing up", edit: "Changing", change: "Changing" };
  const words = lead[verb ?? ""] ? `${lead[verb!]} ${what ? `your ${what}` : "it"}` : name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
