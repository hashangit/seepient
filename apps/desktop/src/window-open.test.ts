import { describe, expect, it } from "vitest";
import { oauthPopupSessionPreferences, shouldOpenInAppPopup } from "./window-open.js";

const appOrigin = "https://seepients.example.com";

describe("desktop child windows", () => {
  it("keeps same-origin app routes in Electron", () => {
    expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/mcp/oauth/callback`, "_blank")).toBe(true);
  });

  it("opens ordinary external links outside Electron", () => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://github.com/elie222/seepients/pull/395", "_blank"),
    ).toBe(false);
  });

  it.each([
    "seepients-model-oauth",
    "seepients-mcp-oauth",
    "seepients-sso-oauth",
    "seepients-app-connect",
    "seepients-plugin-connect",
  ])("keeps the intentional %s flow in an Electron popup", (frameName) => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://provider.example.com/authorize", frameName),
    ).toBe(true);
  });

  it("rejects malformed URLs and non-HTTPS third-party targets", () => {
    expect(shouldOpenInAppPopup(appOrigin, "not a url", "seepients-model-oauth")).toBe(false);
    expect(
      shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "seepients-model-oauth"),
    ).toBe(false);
  });
});

it("keeps SSO popups sandboxed in the parent session without a privileged preload", () => {
  expect(oauthPopupSessionPreferences("persist:test-server")).toEqual({
    partition: "persist:test-server",
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
  expect(oauthPopupSessionPreferences(null)).not.toHaveProperty("partition");
  expect(shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "seepients-sso-oauth")).toBe(
    false,
  );
});

it("allows only the named SSO blank popup before provider navigation", () => {
  expect(shouldOpenInAppPopup(appOrigin, "about:blank", "seepients-sso-oauth")).toBe(true);
  for (const name of ["_blank", "seepients-mcp-oauth", ""])
    expect(shouldOpenInAppPopup(appOrigin, "about:blank", name)).toBe(false);
  expect(shouldOpenInAppPopup(appOrigin, "about:blank#unsafe", "seepients-sso-oauth")).toBe(false);
});
