/** @type {import('next').NextConfig} */
export default {
  // Required by the Dockerfile runtime stage.
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@ariadne/shared"],
};
