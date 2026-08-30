export type Mailer = {
  send(input: { to: string; subject: string; body: string }): Promise<void>;
};
