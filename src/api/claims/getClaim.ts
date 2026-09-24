router.get('/claims/:id', async (req, res) => {
  const record = await db.claimRecord.findUnique({ where: { id: req.params.id } });
  if (!record) return res.status(404).json({ error: 'not_found' });
  // API only ever serves the projection — never re-derives or mutates authority state
  return res.json(toPublicClaimView(record));
});
