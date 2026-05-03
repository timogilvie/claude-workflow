revision = "008"
down_revision = "007"

from alembic import op


def upgrade():
    op.execute("CREATE INDEX CONCURRENTLY widgets_count_idx ON widgets(count)")


def downgrade():
    pass
