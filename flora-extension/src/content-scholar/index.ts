import { observeScholarResults, processScholarResults } from "./observer";

// Process any results already on the page
processScholarResults(document);

// Start observing for dynamically loaded results
observeScholarResults();
