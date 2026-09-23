// chrome-extension/bridge-input.js
// Parsing for the two fields the options page asks for: the bridge port and the token.
//
// Its own file because it is the one piece of the options page with a rule worth testing, and because
// the page is a classic script with no build step — a plain `window` export is the only seam
// available (see test/unit/chrome-extension/bridgeInput.test.js).
//
// WHY IT ACCEPTS MORE THAN A NUMBER: Folia's settings panel shows the address as a whole string
// (`ws://127.0.0.1:32110`), so pasting it into the port field is the obvious thing to do. The field
// used to be `<input type="number">`, which silently DELETED the non-digits: `ws://127.0.0.1:32110`
// became `127.00132110`, parsed as port 127, and the extension sat in "Disconnected — retrying"
// forever with nothing on screen explaining why. A wrong value the user cannot see is worse than a
// rejected one, so this parses the shapes people actually paste and says what is wrong otherwise.

'use strict';

(function (global) {
  var DEFAULT_PORT = 32110;
  var MIN_PORT = 1;
  var MAX_PORT = 65535;

  function isValidPort(value) {
    return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
  }

  /**
   * The port inside whatever the user pasted, or null.
   *
   * Accepts `32110`, `127.0.0.1:32110`, `ws://127.0.0.1:32110`,
   * `ws://127.0.0.1:32110/external-media/ws?token=…` — i.e. anything whose port is unambiguous.
   * A bare `127.0.0.1` has none, and is reported as such rather than guessed at.
   */
  function extractPort(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) {
      return null;
    }

    // Plain digits are the common case and must not go through URL parsing: `32110` alone is not a
    // valid URL, and `http://32110` would read the digits as a HOST, not a port.
    if (/^[0-9]+$/.test(text)) {
      return Number.parseInt(text, 10);
    }

    var withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'ws://' + text;
    try {
      var parsed = new URL(withScheme);
      if (!parsed.port) {
        return null;
      }
      return Number.parseInt(parsed.port, 10);
    } catch (error) {
      return null;
    }
  }

  /** The token inside a pasted URL (`…?token=abc`), or null. Lets one paste fill both fields. */
  function extractToken(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text || text.indexOf('token=') === -1) {
      return null;
    }
    var match = /[?&]token=([^&\s]+)/.exec(text);
    if (!match) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return match[1];
    }
  }

  /**
   * Validates the form. Returns `{ config }` or `{ error, token }`.
   *
   * `token` is returned alongside an error when a token could still be recovered from the input, so
   * the caller can fill the token field even when the port itself was unusable.
   */
  function parseBridgeInput(rawPort, rawToken) {
    var port = extractPort(rawPort);
    var token = String(rawToken == null ? '' : rawToken).trim() || extractToken(rawPort) || '';

    if (port === null) {
      var looksLikeAddress = /[:/]/.test(String(rawPort == null ? '' : rawPort));
      return {
        error: looksLikeAddress
          ? 'That is an address, not a port. Use just the number Folia shows, e.g. 32110.'
          : 'Port must be a number between 1 and 65535.',
        token: token,
      };
    }
    if (!isValidPort(port)) {
      return { error: 'Port must be a number between 1 and 65535.', token: token };
    }
    if (!token) {
      return { error: 'Token is required. Copy it from Folia.', token: '' };
    }

    return { config: { port: port, token: token } };
  }

  global.FoliaBridgeInput = {
    DEFAULT_PORT: DEFAULT_PORT,
    extractPort: extractPort,
    extractToken: extractToken,
    parseBridgeInput: parseBridgeInput,
  };
})(typeof window !== 'undefined' ? window : globalThis);
