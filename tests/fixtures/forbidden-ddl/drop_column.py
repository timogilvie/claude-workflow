revision = "003"
down_revision = "002"

from alembic import op


def upgrade():
    op.drop_column("widgets", "legacy_name")


def downgrade():
    pass
