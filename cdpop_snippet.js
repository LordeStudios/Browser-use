const CDP_OP_MS = 5000;
async function cdpOp(ctx, name, fn) {
  const c = await client(ctx);
  return Promise.race([
    fn(c),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP timeout (${name}) after ${CDP_OP_MS}ms`)), CDP_OP_MS))
  ]);
}