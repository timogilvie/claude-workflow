def upgrade():
    op.drop_table("users")


def downgrade():
    op.create_table("users")
