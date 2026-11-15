// Shared-secret checks. A real chat tool would sign its requests; verify that signature here.
export const chatAuthorised = (req) => req.headers.get('x-chat-secret') === process.env.CHAT_SECRET;
export const cronAuthorised = (req) => req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`;
