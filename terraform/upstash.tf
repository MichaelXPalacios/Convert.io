# The posterior mirror. Postgres remains the source of truth; this holds a copy
# the request path can read in one round trip.
#
# Accessed over Upstash's REST API rather than a TCP client. The original
# reason was that Vercel's edge runtime has no raw sockets, and that reason no
# longer holds: Next 16 deprecates the edge runtime and the routes run on Node.
# REST stays because it is a single fetch that behaves identically on both
# runtimes, not because a socket is unavailable. Do not "fix" this back to a
# TCP client on the strength of the obsolete justification.
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
