import { redirect } from "next/navigation";

/**
 * The root is not an experiment. Send it to the one landing page this
 * deployment carries rather than rendering an empty shell.
 */
export default function Home() {
  redirect("/demo-landing");
}
