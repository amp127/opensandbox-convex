import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Pause idle sandboxes, destroy abandoned ones (never those marked
// persist=true), and trim old rows and run history.
crons.interval("sandbox housekeeping", { minutes: 10 }, internal.housekeeping.run, {});

export default crons;
