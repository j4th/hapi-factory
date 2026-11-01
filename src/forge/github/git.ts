/**
 * Authenticated git (design §3.4): the token reaches git only through the spawned process's
 * environment, as config (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0`), never argv,
 * a URL, a credential helper or a file.
 */
export function authedGit(token: string): Record<string, string> {
  if (!/^\S+$/.test(token)) throw new Error("authedGit: the token is empty or holds whitespace");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}
