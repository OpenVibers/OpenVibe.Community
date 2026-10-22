-- phase: migrate
-- Pulse's blog items were titled "New post on the [object Object] blog": blog.post.published carries its blog as
-- { id, handle } and the consumer printed the object (fixed in server/pulse/consumer.js). Each such item gets the
-- handle from its own canonical URL (https://openvibe.blog/@<handle>/<post>), as the consumer now writes it.
UPDATE pulse_items
   SET title = 'New post on the ' || substring(url FROM '^https://[^/]+/@([a-z0-9][a-z0-9_-]{1,39})/') || ' blog'
 WHERE source_service = 'blog'
   AND title = 'New post on the [object Object] blog'
   AND substring(url FROM '^https://[^/]+/@([a-z0-9][a-z0-9_-]{1,39})/') IS NOT NULL;
UPDATE pulse_items
   SET title = 'New post on an OpenVibe blog'
 WHERE source_service = 'blog'
   AND title = 'New post on the [object Object] blog';
