/**
 * Vendor quarantine — the only module allowed to import the OpenAI SDK.
 * Everything vendor-shaped enters the system through this file.
 */
export { OpenAI } from 'openai';
