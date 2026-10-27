import "node:module";
/** Call explicitly before endpoint construction. The embedding application
 * owns signal shutdown and must retire its native trees before exiting. */
export { configureProcessSignalHandling } from "@momics/iroh-http-node";
