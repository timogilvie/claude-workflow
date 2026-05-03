revision = "004"
down_revision = "003"

from alembic import op


def upgrade():
    op.drop_table("widgets")


def downgrade():
    pass
