import type { Settings } from "./settings";
import type { ConnectionStatus } from "./rpc";

export type PopupStatus = {
  connection: ConnectionStatus;
  settings: Settings;
  session: { active: boolean; status: string };
  restricted: boolean;
  restrictedMessage: string | null;
  browser: "chrome" | "firefox";
};
