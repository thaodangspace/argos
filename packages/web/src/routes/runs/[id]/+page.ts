import type { PageLoad } from "./$types";

/** The route only supplies the id; the SPA reads the run over HTTP (there is no SSR). */
export const load: PageLoad = ({ params }) => ({ runId: params.id });
