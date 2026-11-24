import { Router } from 'express';
import { randomUUID } from 'node:crypto';

const router = Router();

// In-memory store – swap for a database later.
let todos = [
  { id: randomUUID(), title: 'Try the Flutter frontend', done: false },
];

router.get('/', (_req, res) => res.json(todos));

router.post('/', (req, res) => {
  const title = (req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  const todo = { id: randomUUID(), title, done: false };
  todos.push(todo);
  res.status(201).json(todo);
});

router.patch('/:id', (req, res) => {
  const todo = todos.find((t) => t.id === req.params.id);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  if (typeof req.body?.title === 'string') todo.title = req.body.title.trim();
  if (typeof req.body?.done === 'boolean') todo.done = req.body.done;
  res.json(todo);
});

router.delete('/:id', (req, res) => {
  const before = todos.length;
  todos = todos.filter((t) => t.id !== req.params.id);
  if (todos.length === before) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

export default router;
