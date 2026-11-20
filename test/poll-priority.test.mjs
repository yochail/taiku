import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTaskRoots } from '../src/lib/run.mjs';

test('guaranteed poll roots run before news threads and other roots', () => {
  const topicRoot = { taskId: 'news-root', topicId: 'top-story' };
  const pollRoot = { taskId: 'poll-root', media: 'poll' };
  const otherRoot = { taskId: 'other-root' };
  const earlierStory = { taskId: 'earlier-story', topicId: 'earlier-story' };
  const topics = [{ id: 'earlier-story' }, { id: 'top-story' }];
  const roots = [topicRoot, otherRoot, pollRoot, earlierStory].sort((a, b) => compareTaskRoots(a, b, topics));
  assert.deepEqual(roots, [pollRoot, earlierStory, topicRoot, otherRoot]);
});
