"""Migration whose downgrade raises NotImplementedError without parens."""

revision = "004"
down_revision = "003"


def upgrade():
    op.create_index("ix_orders_user", ["user_id"])


def downgrade():
    raise NotImplementedError
