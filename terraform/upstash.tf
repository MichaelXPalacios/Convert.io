# The posterior mirror. Postgres remains the source of truth; this holds a copy
# the edge can read in one round trip on the hot path.
#
# Kept in the region nearest the Neon project so the worker's write path is not
# crossing the country twice per recompute.

resource "upstash_redis_database" "mirror" {
  database_name  = "${var.project_name}-mirror"
  region         = "global"
  primary_region = var.upstash_region
  tls            = true

  # The mirror is a cache of a table that can always be recomputed, so evicting
  # under memory pressure is correct behaviour rather than data loss.
  eviction = true
}
