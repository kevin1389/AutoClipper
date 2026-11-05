/**
 * One SQL statement reserves capacity and inserts the reservation. SQLite and
 * D1 serialize writes, so concurrent Workers cannot both observe the same free
 * bytes and exceed a provider cap.
 *
 * Usage is:
 *  - complete objects plus pending objects without an active reservation;
 *  - active reservations (including multipart uploads whose bytes are not
 *    visible in a provider listing yet);
 *  - the last measured non-AutoClipper bytes in that bucket.
 *
 * `storage_provider_state.external_bytes` is the difference between the last
 * successful provider listing and complete AutoClipper objects. Keeping it in
 * D1 lets a reservation include unrelated bucket objects without relying on
 * a process-local listing cache.
 */
export const RESERVE_STORAGE_CAPACITY_SQL = `
INSERT INTO storage_reservations (
  id, reservation_key, storage_object_id, project_id, provider_id, bytes,
  status, expires_at, created_at, updated_at
)
SELECT
  candidate.id, candidate.reservation_key, candidate.storage_object_id,
  candidate.project_id, candidate.provider_id, candidate.bytes,
  'active', candidate.expires_at, candidate.created_at, candidate.updated_at
FROM (
  SELECT ? AS id, ? AS reservation_key, ? AS storage_object_id,
         ? AS project_id, ? AS provider_id, ? AS bytes, ? AS expires_at,
         ? AS created_at, ? AS updated_at
) AS candidate
WHERE
  candidate.bytes + (
    MAX(
      COALESCE((
        SELECT SUM(so.bytes) FROM storage_objects so
        WHERE so.provider_id = candidate.provider_id
          AND so.status IN ('pending', 'uploading', 'complete')
          AND NOT EXISTS (
            SELECT 1 FROM storage_reservations active
            WHERE active.storage_object_id = so.id AND active.status = 'active'
          )
      ), 0),
      COALESCE((
        SELECT state.listed_bytes FROM storage_provider_state state
        WHERE state.provider_id = candidate.provider_id
      ), 0)
    )
    + COALESCE((
      SELECT SUM(active.bytes) FROM storage_reservations active
      WHERE active.provider_id = candidate.provider_id AND active.status = 'active'
    ), 0)
  ) <= ?
  AND candidate.bytes + (
    COALESCE((
      SELECT SUM(MAX(
        COALESCE((
          SELECT SUM(so.bytes) FROM storage_objects so
          WHERE so.provider_id = providers.provider_id
            AND so.status IN ('pending', 'uploading', 'complete')
            AND NOT EXISTS (
              SELECT 1 FROM storage_reservations active
              WHERE active.storage_object_id = so.id AND active.status = 'active'
            )
        ), 0),
        COALESCE((
          SELECT state.listed_bytes FROM storage_provider_state state
          WHERE state.provider_id = providers.provider_id
        ), 0)
      ))
      FROM (
        SELECT provider_id FROM storage_provider_state
        UNION
        SELECT DISTINCT provider_id FROM storage_objects
        WHERE status IN ('pending', 'uploading', 'complete')
      ) AS providers
    ), 0)
    + COALESCE((
      SELECT SUM(active.bytes) FROM storage_reservations active
      WHERE active.status = 'active'
    ), 0)
  ) <= ?
`;
