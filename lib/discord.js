/**
 * ✅ LIB/DISCORD.JS - DE COMPATIBILITEIT-WRAPPER
 * * Dit bestand zorgt ervoor dat je oude imports niet breken.
 * Het stuurt alles door naar de nieuwe 'sendDiscord' (de motor) 
 * en 'sendSignal' (de router).
 */

// Importeer de robuuste verzender
import { sendDiscord as robustSender } from "./sendDiscord.js";

// Importeer de slimme router voor signalen
import { sendSignal as routerSender } from "./discordRouter.js";

/**
 * sendDiscord
 * Gebruik dit voor directe, handmatige aanroepen naar een specifieke webhook.
 * Nu met automatische retries en 429-handling via sendDiscord.js.
 */
export const sendDiscord = robustSender;

/**
 * sendSignal
 * Gebruik dit voor je scanner-signalen en trade-updates.
 * Dit regelt automatisch de juiste webhook op basis van je Vercel-instellingen.
 */
export const sendSignal = routerSender;

/**
 * Default export voor het geval je 'import Discord from "./Discord"' gebruikt.
 */
export default {
  send: robustSender,
  signal: routerSender
};
